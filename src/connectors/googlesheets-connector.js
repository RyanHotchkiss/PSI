'use strict';

const assert = require('../utils/assert');
const patternFilter = require('../utils/pattern-filter');
const Status = require('../common/status');
const setObject = require('../utils/set-object');
const transpose = require('../utils/transpose');
const Connector = require('./connector');
const {GoogleSheetsHelper, SystemVars, TabRole} = require('../helpers/googlesheets-helper');

const DataAxis = {
  ROW: 'row',
  COLUMN: 'column',
};

/**
 * the connector handles read and write actions with GoogleSheets as a data
 * store. This connector works together with
 * `src/extensions/googlesheets-extensions.js` and
 * `src/helpers/googlesheets-helper.js`.
 */
class GoogleSheetsConnector extends Connector {
  /**
   * constructor - Initilize the instance  with given config object and
   * singleton ApiHandler instance. The config object is a sub-property from
   * the awpConfig object at the top level.
   * @param  {Object} config The config object for initializing this connector.
   * @param  {Object} apiHelper ApiHandler instance initialized in awp-core.
   */
  constructor(config, apiHelper) {
    super();
    assert(config.tabs, 'tabs is missing in config.');
    assert(config.defaultTestsTab, 'defaultTestsTab is missing in config.');
    assert(config.defaultResultsTab, 'defaultResultsTab is missing in config.');

    this.apiHelper = apiHelper;
    this.locationApiEndpoint = 'http://www.webpagetest.org/getLocations.php?f=json&k=A';
    this.activeSpreadsheet = SpreadsheetApp.getActive();
    this.defaultTestsTab = config.defaultTestsTab;
    this.defaultResultsTab = config.defaultResultsTab;

    // Construct individual tab config from this.tabs.
    this.tabConfigs = {};
    config.tabs.forEach(tabConfig => {
      assert(tabConfig.tabName,
          `tabName is missing in tabConfig: ${tabConfig}`);
      assert(tabConfig.tabRole,
          `tabRole is missing in tabConfig: ${tabConfig}`);

      switch(tabConfig.tabRole) {
        case TabRole.SYSTEM:
          this.tabConfigs.systemTab = tabConfig;
          break;

        case TabRole.CONFIG:
          this.tabConfigs.configTab = tabConfig;
          break;

        // Note: the Locations tab is dedciated for WebPageTest-based tests.
        case TabRole.LOCATIONS:
          this.tabConfigs.locationsTab = tabConfig;
          break;

        default:
          this.tabConfigs[tabConfig.tabName] = tabConfig;
          break;
      }
    });

    assert(this.tabConfigs.configTab, 'configTab is missing in config.tabs.');
    assert(this.tabConfigs.systemTab, 'systemTab is missing in config.tabs.');
    assert(this.tabConfigs.locationsTab, 'locationsTab is missing in config.tabs.');

    // The list of validation rules for all tabs.
    this.validationsMaps = config.validationsMaps;

    // Mapping of conditional formatting, used by resultsTab and latestResultsTab.
    this.columnConditions = {
      'webpagetest.metrics.lighthouse.Performance': [0.4, 0.74, 0.75],
      'webpagetest.metrics.lighthouse.ProgressiveWebApp': [0.4, 0.74, 0.75],
      'webpagetest.metrics.lighthouse.FirstContentfulPaint': [5000, 4000, 2000],
      'webpagetest.metrics.lighthouse.FirstMeaningfulPaint': [5500, 4500, 2500],
      'webpagetest.metrics.lighthouse.FirstInputDelay': [300, 250, 50],
      'webpagetest.metrics.lighthouse.TimeToInteractive': [8000, 7000, 5000],
      'webpagetest.metrics.FirstContentfulPaint': [5000, 4000, 2000],
      'webpagetest.metrics.FirstMeaningfulPaint': [5500, 4500, 2500],
      'webpagetest.metrics.DOMContentLoaded': [7000, 3500, 2000],
      'webpagetest.metrics.TimeToInteractive': [8000, 7000, 5000],
      'webpagetest.metrics.SpeedIndex': [8000, 4500, 3000],
      'webpagetest.metrics.TimeToFirstByte': [4000, 2000, 1000],
      'webpagetest.metrics.FirstPaint': [4500, 3000, 1500],
      'webpagetest.metrics.VisualComplete': [8000, 4500, 3000],
      'webpagetest.metrics.LoadEvent': [10000, 6500, 5000],
      'webpagetest.metrics.Connections': [30, 20, 10],
    };

    this.healthCheck();
  }

  /**
   * init - Initializing the AWP on Spreadsheets, including adding triggers,
   * get all locations from WebPageTest, init conditional formatting, and get
   * user timeozone.
   */
  init() {
    // Delete all previous triggers, and create submitting recurring trigger.
    this.initTriggers();

    // Refresh location list.
    this.initLocations();

    // Init all validations.
    this.initValidations();

    // Init condition formatting for all Result tabs.
    this.getTabIds(TabRole.RESULTS).forEach(tabId => {
      this.initConditionalFormat(tabId);
    });

    // Init user timezone.
    this.initUserTimeZone();

    // Request for WebPageTest API Key.
    this.requestApiKey();

    // Record the last timestamp of init.
    this.setSystemVar(SystemVars.LAST_INIT_TIMESTAMP, Date.now());
  }

  /**
   * getList - The helper function for getting arbitrary items, like Tests,
   * Results, or Config items.
   * @param  {type} tabId The keys of tabConfigs. E.g. "configTab"
   * @param  {type} options Options: appendRowIndex, verbose or debug.
   */
  getList(tabId, options) {
    options = options || {};
    let tabConfig = this.tabConfigs[tabId];
    let data = this.getSheet(tabId).getDataRange().getValues();

    let skipRows = tabConfig.skipRows || 0;
    let skipColumns = tabConfig.skipColumns || 0;

    if (tabConfig.dataAxis === DataAxis.COLUMN) {
      data = transpose(data);
      skipRows = tabConfig.skipColumns;
      skipColumns = tabConfig.skipRows;
    }

    let propertyLookup = data[tabConfig.propertyLookup - 1];
    data = data.slice(skipRows, data.length);

    let items = [];
    for (let i = 0; i < data.length; i++) {
      let newItem = {};
      for (let j = skipColumns; j < data[i].length; j++) {
        if (propertyLookup[j]) {
          if (typeof propertyLookup[j] !== 'string') {
            throw new Error(
                `${tabId} Tab: Property lookup ${propertyLookup[j]} is not a string`);
          }

          setObject(newItem, propertyLookup[j], data[i][j]);
        }
      }

      // Add metadata for GoogleSheets.
      if (options.appendRowIndex) {
        newItem.googlesheets = {
          rowIndex: i + tabConfig.skipRows + 1,
        };
      }
      items.push(newItem);
    }

    return items;
  }

  /**
   * getTestList - Return the array of Tests, supporting Pattern filters.
   * Checkout `src/utils/pattern-filter.js` for more details.
   * @param  {object} options Options including filters, verbose and debug.
   * @return {Array<object>} description
   */
  getTestList(options) {
    options = options || {};
    options.appendRowIndex = true;
    let googlesheets = options.googlesheets || {};

    // If tabId is not specified, use the default Tests tabId.
    let tests = this.getList(googlesheets.testsTab || this.defaultTestsTab, options);
    tests = patternFilter(tests, options.filters);
    return tests;
  }

  /**
   * updateTestList - Update the array of new Tests to the original Tests,
   * based on the RowIndex of each Test in the "Tests" Sheet.
   * @param  {Array<object>} newTests The array of new Test objects.
   * @param  {object} options Options: filters, verbose and debug.
   */
  updateTestList(newTests, options) {
    options = options || {};
    let googlesheets = options.googlesheets || {};

    // If tabId is not specified, use the default Tests tabId.
    this.updateList(googlesheets.testsTab || this.defaultTestsTab, newTests,
        (test, rowIndex) => {
      // test.googlesheets.rowIndex in each Test is added in getList().
      return test.googlesheets.rowIndex;
    } /* rowIndexFunc */);
  }

  /**
   * getRowRange - The helper function get the GoogleSheets Range object for the
   * entire row with given row index.
   * @param  {string} tabId The keys of tabConfigs. E.g. "testsTab"
   * @param  {number} rowIndex The row index in a sheet. (starting from 1)
   * @return {object} GoogleSheets Range object
   */
  getRowRange(tabId, rowIndex) {
    let sheet = this.getSheet(tabId);
    let lastColumn = sheet.getLastColumn();
    return sheet.getRange(rowIndex, 1, 1, lastColumn);
  }

  /**
   * getColumnRange - Return the GoogleSheets Range object for
   * the entire column with given propertyKey.
   * @param  {string} tabId The keys of tabConfigs. E.g. "testsTab"
   * @param  {string} propertyKey The property key for the column. E.g. "webpagetest.metrics.CSS"
   * @return {object} GoogleSheets Range object
   */
  getColumnRange(tabId, propertyKey) {
    let tabConfig = this.tabConfigs[tabId];
    let sheet = this.getSheet(tabId);
    let columnIndex = this.getPropertyIndex(tabId, propertyKey);
    let range = sheet.getRange(tabConfig.skipRows + 1,
        columnIndex, sheet.getLastRow() - tabConfig.skipRows, 1);
    return range;
  }

  /**
   * getResultList - Return the array of Results, supporting PatternFilter.
   * @param  {object} options Options: filters, verbose and debug.
   * @return {Array<object>} Arary of Results.
   */
  getResultList(options) {
    options = options || {};
    options.appendRowIndex = true;
    let googlesheets = options.googlesheets || {};

    // If tabId is not specified, use the default Results tabId.
    let tabId = googlesheets.resultsTab || this.defaultResultsTab;
    let results = this.getList(tabId, options);
    results = patternFilter(results, options.filters);

    return results;
  }

  /**
   * appendResultList - Append new results to the end of the existing Results.
   * @param  {Array<object>} newResults Array of new Results
   */
  appendResultList(newResults, options) {
    options = options || {};
    let googlesheets = options.googlesheets || {};

    // If tabId is not specified, use the default Results tabId.
    let tabId = googlesheets.resultsTab || this.defaultResultsTab;
    let tabConfig = this.tabConfigs[tabId];

    // Use the last row index as base for appending results.
    let lastRowIndex = this.getColumnRange(tabId, 'id').getLastRow() + 1;
    this.updateList(tabId, newResults, (result, rowIndex) => {
      rowIndex = lastRowIndex;
      lastRowIndex++;
      return rowIndex;
    } /* rowIndexFunc */);
  }

  /**
   * updateResultList - Override the Results with specific rowIndex.
   * @param  {Array<object>} newResults Array of new Results
   */
  updateResultList(newResults, options) {
    options = options || {};
    let googlesheets = options.googlesheets || {};

    // If tabId is not specified, use the default Results tabId.
    let tabId = googlesheets.resultsTab || this.defaultResultsTab;
    let tabConfig = this.tabConfigs[tabId];
    let rowIndex = tabConfig.skipRows + 1;

    this.updateList(tabId, newResults, (result, rowIndex) => {
      return result.googlesheets.rowIndex;
    } /* rowIndexFunc */);
  }

  /**
   * getPropertyLookup - Return an array of property keys from the Row of
   * PropertyLookup.
   * @param  {string} tabId The keys of tabConfigs. E.g. "testsTab"
   * @return {Array<string>} Array of property keys.
   */
  getPropertyLookup(tabId) {
    let tabConfig = this.tabConfigs[tabId];
    let sheet = this.getSheet(tabId);
    let skipRows = tabConfig.skipRows || 0;
    let skipColumns = tabConfig.skipColumns || 0;

    if (tabConfig.dataAxis === DataAxis.ROW) {
      let data = sheet.getRange(
          tabConfig.propertyLookup, skipColumns + 1,
          1, sheet.getLastColumn() - skipColumns - 1).getValues();
      return data[0];

    } else {
      let data = sheet.getRange(
          skipRows + 1, tabConfig.propertyLookup,
          sheet.getLastRow() - skipRows, 1).getValues();
      return data.map(x => x[0]);
    }
  }

  /**
   * getPropertyIndex - Return the index with a given property key. E.g.
   * getPropertyIndex('webpagetest.metrics.CSS') returns the column inex for
   * CSS metric column.
   * @param  {string} tabId The keys of tabConfigs. E.g. "testsTab"
   * @param  {string} lookupKey Property key of the column to look up.
   * @return {number} Column index.
   */
  getPropertyIndex(tabId, lookupKey) {
    let propertyLookup = this.getPropertyLookup(tabId);
    for (let i = 0; i < propertyLookup.length; i++) {
      if (propertyLookup[i] === lookupKey) {
        return i + 1;
      }
    }
  }

  /**
   * initTriggers - Create recurring and onEdit triggers if not exist.
   */
  initTriggers() {
    GoogleSheetsHelper.deleteAllTriggers();
    Object.keys(SystemVars).forEach(key => {
      this.setSystemVar(key, '');
    });

    // Create recurring trigger.
    let triggerId;
    triggerId = GoogleSheetsHelper.createTimeBasedTrigger(
        'submitRecurringTests', 10 /* minutes */);
    this.setSystemVar(SystemVars.RECURRING_TRIGGER_ID, triggerId);

    // Create onEdit trigger.
    triggerId = GoogleSheetsHelper.createOnEditTrigger('onEditFunc');
    this.setSystemVar(SystemVars.ONEDIT_TRIGGER_ID, triggerId);
  }

  /**
   * initLocations - Get locations from WebPageTest API and update to Locations
   * tab.
   */
  initLocations() {
    // Reset locations tab.
    let locations = this.getList('locationsTab');
    let tabConfig = this.tabConfigs['locationsTab'];
    let sheet = this.getSheet('locationsTab');

    // Get new locations from remote API.
    let res = this.apiHelper.fetch(this.locationApiEndpoint);
    let json = JSON.parse(res);

    let newLocations = [];
    let pendingByLocation = {}
    Object.keys(json.data).forEach(key => {
      let data = json.data[key];
      let newLocation = {
        id: key,
        name: `${data.labelShort} (${key})`,
        pendingTests: data.PendingTests.Total,
        browsers: data.Browsers,
      };
      newLocation.key = key;
      pendingByLocation[newLocation.name] = newLocation.pendingTests;
      newLocations.push(newLocation);
    });

    // Add empty rows if the original location list was longer than the new one.
    for (let i=newLocations.length; i<locations.length; i++) {
      newLocations.push({});
    }
    this.updateList('locationsTab', newLocations);

    // Overrides pending tests to property 'webpagetest.pendingTests'.
    let propertyKey = 'webpagetest.pendingTests';
    let tests = this.getTestList({
      filters: ['url', 'webpagetest.settings.location'],
    });
    tests.forEach(test => {
      if (!test.url || !test.webpagetest || !test.webpagetest.settings ||
          !test.webpagetest.settings.location) return;
      test.webpagetest.pendingTests =
          pendingByLocation[test.webpagetest.settings.location];
    });
    this.updateTestList(tests);
  }

  /**
   * updateList - The helper function for updating arbitrary items, like Tests,
   * Results, or Config items.
   * @param  {string} tabId The keys of tabConfigs. E.g. "testsTab"
   * @param  {Array<object>} items Array of new items.
   * @param  {Function} rowIndexFunc The function that returns rowIndex for each item.
   */
  updateList(tabId, items, rowIndexFunc) {
    let tabConfig = this.tabConfigs[tabId];
    let data = this.getSheet(tabId).getDataRange().getValues();
    let propertyLookup = data[tabConfig.propertyLookup - 1];

    let rowIndex = tabConfig.skipRows + 1;
    items.forEach(item => {
      let values = [];
      propertyLookup.forEach(lookup => {
        if (typeof lookup !== 'string') {
          throw new Error(
              `${tabId} Tab: Property lookup ${lookup} is not a string`);
        }
        try {
          let value = lookup ? eval(`item.${lookup}`) : '';
          values.push(value);
        } catch (error) {
          values.push('');
        }
      });

      let targetRowIndex = rowIndexFunc ? rowIndexFunc(item, rowIndex) : rowIndex;
      let range = this.getRowRange(tabId, targetRowIndex);
      range.setValues([values]);
      rowIndex++;
    });
  }

  /**
   * clearList - Clear the entire list of a specific tab.
   * @param {string} tabId The keys of tabConfigs. E.g. "testsTab"
   */
  clearList(tabId) {
    let tabConfig = this.tabConfigs[tabId];
    let sheet = this.getSheet(tabId);
    let lastRow = sheet.getLastRow();
    sheet.deleteRows(tabConfig.skipRows + 1, lastRow - tabConfig.skipRows);
  }

  /**
   * initValidations - Reset all validation rules in the validationsMaps.
   */
  initValidations() {
    this.validationsMaps.forEach(mapping => {
      let targetRange = this.getColumnRange(
          this.getTabId(mapping.targetTab), mapping.targetProperty);
      let validationRange = this.getColumnRange(
          this.getTabId(mapping.validationTab), mapping.validationProperty);
      let rule = SpreadsheetApp.newDataValidation().requireValueInRange(
          validationRange).build();
      targetRange.setDataValidation(rule);
    });
  }

  /**
   * initConditionalFormat - Reset all conditional formatting defined in The
   * columnConditions.
   * @param {string} tabId The keys of tabConfigs. E.g. "testsTab"
   */
  initConditionalFormat(tabId) {
    let rules = [];
    let tabConfig = this.tabConfigs[tabId];
    let sheet = this.getSheet(tabId);
    let propertyLookup = this.getPropertyLookup(tabId);

    let columnIndex = 1;
    propertyLookup.forEach(propertyKey => {
      let conditions = this.columnConditions[propertyKey];
      if (conditions && conditions.length > 0) {
        let range = sheet.getRange(tabConfig.skipRows + 1, columnIndex,
            sheet.getMaxRows() - tabConfig.skipRows, 1);
        let maxpoint = conditions[2], midpoint = conditions[1],
            minpoint = conditions[0];
        let maxcolor = '#68bb50', mincolor = '#e06666';
        if (maxpoint < minpoint) {
          maxpoint = conditions[0];
          maxcolor = '#e06666';
          minpoint = conditions[2];
          mincolor = '#68bb50';
        }

        let rule =
            SpreadsheetApp.newConditionalFormatRule()
                .setGradientMaxpointWithValue(
                    maxcolor, SpreadsheetApp.InterpolationType.NUMBER, maxpoint)
                .setGradientMidpointWithValue(
                    '#ffd666', SpreadsheetApp.InterpolationType.NUMBER, midpoint)
                .setGradientMinpointWithValue(
                    mincolor, SpreadsheetApp.InterpolationType.NUMBER, minpoint)
                .setRanges([range])
                .build();
        rules.push(rule);
      }
      columnIndex++;
    });
    sheet.setConditionalFormatRules(rules);
  }

  /**
   * initUserTimeZone - Set the user timezone to System tab.
   */
  initUserTimeZone() {
    let userTimeZone = GoogleSheetsHelper.getUserTimeZone();
    this.setSystemVar('USER_TIMEZONE', userTimeZone);
  }

  /**
   * requestApiKey - Request for WebPageTest API key.
   * @param  {string} message Message for the UI prompt.
   */
  requestApiKey(message) {
    let apiKey = this.getConfigVar('apiKeys.webpagetest');
    message = message || 'Enter your WebPageTest API Key';
    let requestCount = 0;
    while (!apiKey && requestCount < 3) {
      let input = Browser.inputBox(
          message + ' (register at https://www.webpagetest.org/getkey.php)');
      // The input will be 'cancel' if the user uses the close button on top
      if (input !== 'cancel') {
        apiKey = input;
      } else {
        break;
      }
      requestCount++;
    }
    if (apiKey) {
      this.setConfigVar('apiKeys.webpagetest', apiKey);
    } else {
      Browser.msgBox('A WebPageTest API Key is required for this tool to' +
                     ' function. Please enter one on the hidden User_API_Key' +
                     ' tab to continue using this tool.');
    }
  }

  /**
   * getConfig - Returns the entire Config as an object.
   * @return {object} Config object.
   */
  getConfig() {
    let configValues = this.getList('configTab');
    return configValues ? configValues[0] : null;
  }

  /**
   * getConfigVar - Returns a specific variable from the Config tab.
   * @param  {string} key
   * @return {any} value
   */
  getConfigVar(key) {
    return this.getVarFromTab('configTab', key);
  }

  /**
   * setConfigVar - Set a value to a specific variable in the Config tab.
   * @param  {string} key
   * @param  {string} value
   */
  setConfigVar(key, value) {
    this.setVarToTab('configTab', key, value);
  }

  /**
   * getSystemVar - Returns a specific variable from the System tab.
   * @param  {string} key description
   * @param  {string} value
   */
  getSystemVar(key) {
    return this.getVarFromTab('systemTab', key);
  }

  /**
   * setSystemVar - Set a value to a specific variable in the System tab.
   * @param  {string} key
   * @param  {string} value
   */
  setSystemVar(key, value) {
    this.setVarToTab('systemTab', key, value);
  }

  /**
   * getVarFromTab - A generic helper function to get the value of a varible in
   * a specific tab.
   * @param  {string} tabId The keys of tabConfigs. E.g. "configTab"
   * @param  {string} key
   * @return {type} value
   */
  getVarFromTab(tabId, key) {
    let object = (this.getList(tabId) || [])[0];
    try {
      return eval('object.' + key);
    } catch(e) {
      return null;
    }
  }

  /**
   * setVarToTab - A generic helper function to set a value of a varible in
   * a specific tab.
   * @param  {string} tabId The keys of tabConfigs. E.g. "configTab"
   * @param  {type} key
   * @param  {type} value
   */
  setVarToTab(tabId, key, value) {
    let tabConfig = this.tabConfigs[tabId];
    let sheet = this.getSheet(tabId);
    let data = sheet.getDataRange().getValues();
    let propertyLookup = this.getPropertyLookup(tabId);

    let i = 1;
    propertyLookup.forEach(property => {
      if (property === key) {
        let range = sheet.getRange(
            tabConfig.skipRows + i, tabConfig.skipColumns + 1);
        range.setValue(value);
      }
      i++;
    });
  }

  /**
   * Return the sheet object of the given tabId.
   * @param  {string} tabId Tab ID in the tabConfigs object.
   * @return {object} AppScript sheet object.
   */
  getSheet(tabId) {
    let config = this.tabConfigs[tabId];
    assert((config || {}).tabName, `tabName not found in ${tabId} tab config.`);

    let sheet = this.activeSpreadsheet.getSheetByName(config.tabName);
    assert(sheet, `Sheet ${config.tabName} not found.`);
    return sheet;
  }

  /**
   * Return a list of TabIds of the given tab role.
   * @param  {string} tabRole Specific tab role, e.g. TabRole.TESTS.
   * @return {Array<string>} List of tabIds
   */
  getTabIds(tabRole) {
    return Object.keys(this.tabConfigs).filter(tabId => {
      return this.tabConfigs[tabId].tabRole === tabRole;
    });
  }

  /**
   * Return the tabId by a given tabName.
   * @param  {string} tabNmae Specific tab name, e.g. Locations.
   * @return {string} tabId
   */
  getTabId(tabName) {
    let tabIds = Object.keys(this.tabConfigs).filter(tabId => {
      return this.tabConfigs[tabId].tabName === tabName;
    });
    return (tabIds || [])[0];
  }

  /**
   * healthCheck - For integration test. WIP.
   */
  healthCheck() {
    // TODO: validate data type in sheets, e.g. check string type for propertyLookup.
  }
}

module.exports = GoogleSheetsConnector;
