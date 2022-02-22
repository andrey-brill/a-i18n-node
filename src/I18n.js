
import fs from 'fs';
import { join, isAbsolute } from 'path';
import { ErrorCodes, InvalidLineError, NotLoadedError, I18nError, NotResolvedError, DuplicateKeyError, UnappliedChangesError, KeyExistError, KeyNotExistError, InvalidDirectoryError, NoI18nFilesError, InvalidKeyError, ExportError } from './Errors.js';
import { CommentLine, ApprovedLine, NotApprovedLine, DeleteKeyLine, KeyValueSeparator, UpdateLine } from './Constants.js';
import { FullKey } from './FullKey.js';
import { SortedArray } from './SortedArray.js';
import { ConfigDefaults } from './ConfigDefaults.js';
import { debug, getPublicFunctions, throttleAction, safeValue, detectLocale, isI18nFile, isI18nJsFile, getTime } from './Utils.js';

export class I18n {

  constructor(config) {
    this.initialize(config); // making possible override constructor if needed
  }

  initialize(config) {

    this._exportChangeIndex = 0;
    this._lastTimeUpdated = 0;
    this._config = Object.assign({}, ConfigDefaults, config);

    this._resetState();

    if (this._config.debug) {
      debug(this);
    }

    getPublicFunctions(this)
      .forEach(([fn, fnName]) => {
        this[fnName] = (options = {}) => {
          this._validateAction(fnName, options);
          fn.call(this, options);
        };
      });

    this._triggerChange = throttleAction(this, this._triggerChange, 0);
    this._autoExport = throttleAction(this, this._autoExport, 300);
  }

  _resetState() {

    delete this.state;

    this.state = {
      keys: new SortedArray(),
      updates: undefined,
      original: undefined,
      updated: {},
      error: null,
      loaded: false
    };

    this._resetUpdates();
  }

  _resetUpdates() {

    this.state.updates = {
      length: 0,
      before: {},
      after: {}
    };

    this.state.original = this.state.updated;
    this.state.updated = {};
  }

  _cloneState() {
    return Object.assign({},
      this.state,
      {
        files: this._findI18nFiles(),
        keys: {
          array: this.state.keys.array,
          changed: this.state.keys.changed
        }
      }
    );
  }

  _validateAction(fnName, options) {

    if (typeof options === 'function') {
      throw new I18nError(ErrorCodes.InvalidOptions, `Options to ${fnName}() can't be a function.`);
    }

    if (fnName === 'load' || fnName === 'connect' || fnName === 'export') {
      return; // custom validation
    }

    if (!this.state.loaded) {
      throw new NotLoadedError();
    }

    if (this.state.error) {
      throw new NotResolvedError(this.state.error);
    }

  }

  _parseLine(line, typeIndex) {

    const type = line[typeIndex];

    if (type !== CommentLine && type !== ApprovedLine && type !== NotApprovedLine && type !== DeleteKeyLine) {
      throw new InvalidLineError(line);
    }

    const separatorIndex = line.indexOf(KeyValueSeparator);
    if (separatorIndex <= typeIndex) {
      throw new InvalidLineError(line);
    }

    const key = line.substring(typeIndex + 1, separatorIndex);

    return {
      type: type,
      key,
      value: line.substring(separatorIndex + 1)
    };
  }

  // can be without optimizations because file don't have a lot updates usually
  _updateState(fileName, line) {

    const { updates } = this.state;

    if (line.indexOf('\n') >= 0) {
      throw new InvalidLineError(line);
    }

    const parsedLine = this._parseLine(line, 1);
    const fullKey = FullKey(fileName, parsedLine.key);

    updates.length++;
    updates.before[fullKey] = this.state.original[fullKey];

    if (parsedLine.type === DeleteKeyLine) {
      delete updates.after[fullKey];
      delete this.state.updated[fullKey];
      this.state.keys.remove(parsedLine.key);
    } else {
      this._resolveTranslation(fullKey, parsedLine, this.state.updates.after);
    }
  }


  _resolveTranslation(fullKey, parsedLine, targetObject) {

    let translation = targetObject[fullKey];
    if (!translation) {
      translation = targetObject[fullKey] = { key: parsedLine.key };
    }

    if (parsedLine.type === CommentLine) {
      translation.comment = parsedLine.value;
    } else {
      translation.value = parsedLine.value;
      translation.approved = parsedLine.type === ApprovedLine;
    }

    // always updating
    this.state.updated[fullKey] = translation;
  }

  _updateKeys() {
    const updateKeys = new Set();
    Object.keys(this.state.updates.before).forEach(fullKey => updateKeys.add(fullKey));
    Object.keys(this.state.updates.after).forEach(fullKey => updateKeys.add(fullKey));
    return updateKeys;
  }

  // removing updates if they don't change the state
  _optimizeUpdates() {

    this._changeUpdates((fullKey) => {

      const original = this.state.original[fullKey];
      const updated = this.state.updated[fullKey];

      if (original && updated &&
        safeValue(original.comment) === safeValue(updated.comment) &&
        safeValue(original.value) === safeValue(updated.value) &&
        (original.approved || false) === (updated.approved || false)) {
        delete this.state.updates.before[fullKey];
        delete this.state.updates.after[fullKey];
      }
    });
  }

  _changeUpdates(fn) {

    const updateKeys = this._updateKeys();
    if (updateKeys.size === 0) {
      return;
    }

    updateKeys.forEach(fn);

    const optimizedKeys = this._updateKeys();
    this.state.updates.length = optimizedKeys.size;

    if (updateKeys.size > 0 && optimizedKeys.size === 0) {
      this.save(); // making sure if all updates "reverted" to remove update-lines from files
    }
  }

  _findFiles(filter) {

    const { directory = './' } = this._config;

    if (!fs.existsSync(directory)) {
      throw new InvalidDirectoryError(directory);
    }

    return this._config
      .filesIn(directory)
      .filter(filter)
      .map(name => ({
        name,
        path: join(directory, name)
      }));

  }

  _findI18nFiles() { return detectLocale(this._findFiles(isI18nFile)); };
  _findI18nJsFile() { return this._findFiles(isI18nJsFile)[0]; };

  _pathTo(fileName) {
    return join(this._config.directory, fileName);
  }

  _appendUpdate(fileName, line) {

    const updateLine = UpdateLine + line;

    this._updateState(fileName, updateLine);
    this._optimizeUpdates();
    this._config.appendLine(this._pathTo(fileName), updateLine);

    this._lastTimeUpdated = getTime();
  }

  _triggerChange() {
    try {
      if (this._onChange) {
        this._onChange(this._cloneState());
      }
    } finally {
      this.state.keys.updated = false;
    }
  }

  _validateKey(key) {

    if (key && key.length > 0 && key.indexOf(KeyValueSeparator) === -1) {
      return;
    }

    throw new InvalidKeyError(key);
  }

  _autoExport() {
    if (this._config.autoExport) {
      this._lastTimeUpdated = getTime();
      this.export({ type: 'auto' });
      this._lastTimeUpdated = getTime(); // if export goes into the same directory
    }
  }

  _export(exportOptions, exporter) {

    if (this._config.debug) {
      console.time('_export');
    }

    try {
      const { open, write, close, validate } = exporter;

      if (validate) {
        validate(exportOptions, this.state);
      }

      for (const file of this._findI18nFiles()) {
        const openResult = open(exportOptions, file);
        for (const key of this.state.keys.array) {
          const t = this.state.updated[FullKey(file.name, key)];
          if (t) {
            write(openResult, t);
          }
        }
        close(openResult, file);
      }
    } catch (e) {
      throw new ExportError(e);
    } finally {
      if (this._config.debug) {
        console.timeEnd('_export');
      }
    }
  }


  connect({ onChange }) {

    if (!fs.existsSync(this._config.directory)) {
      throw new InvalidDirectoryError(this._config.directory);
    }

    if (!this.state.loaded) {
      this.load();
    }

    this._onChange = onChange;

    const ignoreChangesTimeoutMs = 1000;
    const load = throttleAction(this, this.load, 300); // if several updates applied at the same time

    const watcher = fs.watch(this._config.directory, undefined, (eventType, fileName) => {

      if (isI18nJsFile(fileName)) {
        this._exportChangeIndex++;
        return this._autoExport();
      }

      if (isI18nFile(fileName)) {
        if (this._lastTimeUpdated + ignoreChangesTimeoutMs < getTime()) {
          load();
        }
      }
    });

    return () => {
      delete this._onChange;
      watcher.close();
    };
  }

  load() {

    this._resetState();

    try {

      const keys = new Set();

      for (const file of this._findI18nFiles()) {

        const reader = this._config.lineReader(file.path);

        // making sure that file don't have duplicated keys
        const valueKeys = new Set();
        const commentKeys = new Set();

        let lineNumber = 0;
        let line;
        const updates = [];

        while (line = reader.next()) {

          lineNumber++;

          if (line === undefined) {
            continue;
          }

          if (line[0] === UpdateLine) {
            updates.push(line); // update-lines should be handled in the end
            continue;
          }

          try {

            // don't move to separate function, should be only here to reduce amount of validations
            const parsedLine = this._parseLine(line, 0);
            const fullKey = FullKey(file.name, parsedLine.key);
            this._resolveTranslation(fullKey, parsedLine, this.state.original);

            const targetSet = parsedLine.type === CommentLine ? commentKeys : valueKeys;
            if (targetSet.has(parsedLine.key)) {
              throw new DuplicateKeyError(parsedLine.type + parsedLine.key);
            } else {
              keys.add(parsedLine.key);
              targetSet.add(parsedLine.key);
            }

          } catch (e) {

            // adding more info
            if (e.stateError) {
              e.message = `[${file.name}:${lineNumber}] ` + e.message;
            }

            throw e;
          }

        }

        reader.close();

        for (const line of updates) {
          this._updateState(file.name, line);
        }

      }

      this._optimizeUpdates();
      this.state.keys.array = Array.from(keys.values());

    } catch (e) {
      if (e.stateError) {
        this.state.error = e;
      } else {
        throw e;
      }
    }
    finally {
      this.state.loaded = true;
    }

    this._triggerChange();
    this._autoExport();
  }

  // important to make updates to local files under development
  // save state to fs (current state - with updates)
  save() {

    this._lastTimeUpdated = getTime();

    const files = this._findI18nFiles()
      .map(file => ({
        name: file.name,
        writer: this._config.lineWriter(file.path)
      }));

    for (const key of this.state.keys.array) {

      let hasComment = false;
      let hasValue = false;

      for (const file of files) {
        const fullKey = FullKey(file.name, key);
        const t = this.state.updated[fullKey] || {};
        hasComment = hasComment || (t.comment && t.comment.trim().length > 0);
        hasValue = hasValue || (t.value && t.value.trim().length > 0);
        file.t = t;
      }

      for (const file of files) {

        const { approved = false, value = '', comment = '' } = file.t;

        if (hasComment) {
          file.writer.next(CommentLine + key + KeyValueSeparator + comment);
        }

        if (hasComment || hasValue) {
          file.writer.next((approved ? ApprovedLine : NotApprovedLine) + key + KeyValueSeparator + value);
        }
      }

    }

    files.forEach(file => { file.writer.close(); });

    this._resetUpdates();
    this._triggerChange();
    this._autoExport();

    this._lastTimeUpdated = getTime();
  }

  export(options) {

    const exportFile = this._findI18nJsFile();
    if (!exportFile && !this._config.exporter) {
      return;
    }

    const exportOptions = Object.assign({ type: 'manual', config: this._config }, options);

    if (exportOptions.type === 'auto') {
      if (!this.state.loaded) {
        throw new NotLoadedError();
      }
    } else {
      if (!this.state.loaded) {
        const autoExport = this._config.autoExport;
        this._config.autoExport = false;
        this.load();
        this._config.autoExport = autoExport;
      }
    }

    if (this.state.error) {
      throw new NotResolvedError(this.state.error);
    }

    if (this._config.exporter) {
      this._export(exportOptions, this._config.exporter);
      return;
    }

    let modulePath = exportFile.path.replace(/\\/g, '/') + '?v=' + this._exportChangeIndex;
    modulePath = isAbsolute(modulePath) ? modulePath : (modulePath.startsWith('../') ? modulePath : '../' + modulePath);
    import(modulePath).then(module => this._export(exportOptions, module.default));
  }

  addFile({ fileName = '' }) {

    if (this.state.updates.length) {
      throw new UnappliedChangesError();
    }

    if (fileName.length <= 0) {
      throw new I18nError(ErrorCodes.InvalidFile, `File name can't be empty`);
    }

    if (this._findI18nFiles().some(file => file.name === fileName)) {
      throw new I18nError(ErrorCodes.InvalidFile, `File with name "${fileName}" already exist`);
    }

    try {
      this._config.createFile(this._pathTo(fileName));
    } catch (e) {
      throw new I18nError(ErrorCodes.InvalidFile, e.message);
    }

    this.save();
  }

  deleteFile({ fileName = '' }) {

    if (this.state.updates.length) {
      throw new UnappliedChangesError();
    }

    if (!this._findI18nFiles().some(file => file.name === fileName)) {
      return;
    }

    try {
      this._config.deleteFile(this._pathTo(fileName));
    } catch (e) {
      throw new I18nError(ErrorCodes.InvalidFile, e.message);
    }

    this.save();
  }


  addKey({ key }) {

    this._validateKey(key);

    const sortedIndex = this.state.keys.sortedIndexOf(key);
    if (sortedIndex === -1) {
      throw new KeyExistError(key);
    }

    const files = this._findI18nFiles();
    if (files.length == 0) {
      throw new NoI18nFilesError();
    }

    this.state.keys.insert(sortedIndex, key);

    for (const file of files) {
      this.updateValue(file.name, key);
    }
  }

  copyKey({ fromKey, toKey }) {

    if (fromKey === toKey) {
      return;
    }

    this._validateKey(fromKey);
    this._validateKey(toKey);

    const files = this._findI18nFiles();
    if (files.length == 0) {
      throw new NoI18nFilesError();
    }

    if (this.state.keys.indexOf(fromKey) === -1) {
      throw new KeyNotExistError(fromKey);
    }

    const sortedIndex = this.state.keys.sortedIndexOf(toKey);
    if (sortedIndex === -1) {
      throw new KeyExistError(toKey);
    }

    this.state.keys.insert(sortedIndex, toKey);

    for (const file of files) {
      const fullKey = FullKey(file.name, fromKey);
      this.updateTranslation(Object.assign({ fileName: file.name, key: toKey }, this.state.updated[fullKey]));
    }

  }

  renameKey({ fromKey, toKey }) {

    if (fromKey === toKey) {
      return;
    }

    this._validateKey(fromKey);
    this._validateKey(toKey);

    this.copyKey({ fromKey, toKey });
    this.deleteKey({ fromKey });
  }

  deleteKey({ key }) {

    this._validateKey(key);

    if (this.state.keys.remove(key)) {

      for (const file of this._findI18nFiles()) {
        this._appendUpdate(file.name, DeleteKeyLine + key);
      }

      this._triggerChange();
    }
  }

  updateValue({ fileName, key, value }) {

    this._validateKey(key);

    const line = NotApprovedLine + key + KeyValueSeparator + safeValue(value);
    this._appendUpdate(fileName, line);
    this._triggerChange();
  }

  updateApproved({ fileName, key, approved = false }) {

    this._validateKey(key);

    const value = this.state.updated[FullKey(fileName, key)]?.value;
    const line = (approved ? ApprovedLine : NotApprovedLine) + key + KeyValueSeparator + safeValue(value);
    this._appendUpdate(fileName, line);
    this._triggerChange();
  }

  updateComment({ fileName, key, comment }) {

    this._validateKey(key);

    const line = CommentLine + key + KeyValueSeparator + safeValue(comment);
    this._appendUpdate(fileName, line);
    this._triggerChange();
  }

  updateTranslation({ fileName, key, value, comment, approved = false }) {

    this._validateKey(key);

    const commentLine = CommentLine + key + KeyValueSeparator + safeValue(comment);
    const valueLine = (approved ? ApprovedLine : NotApprovedLine) + key + KeyValueSeparator + safeValue(value);
    this._appendUpdate(fileName, commentLine);
    this._appendUpdate(fileName, valueLine);
    this._triggerChange();
  }

  revert({ fileName, key }) {

    this._changeUpdates(fullKey => {

      const splitKey = FullKey.split(fullKey);

      if ((fileName && fileName !== splitKey[0]) || (key && key !== splitKey[1])) {
        return;
      }

      const original = this.state.original[fullKey];
      if (original) {
        this.state.updated[fullKey] = Object.assign({}, original);
      } else {
        delete this.state.updated[fullKey];
      }

      delete this.state.updates.after[fullKey];
      delete this.state.updates.before[fullKey];
    });
  }
}