/**
 *
 * Worker script for browser and node
 *
 * @fileoverview Worker script for browser and node
 * @author Kevin Kwok <antimatter15@gmail.com>
 * @author Guillermo Webster <gui@mit.edu>
 * @author Jerome Wu <jeromewus@gmail.com>
 */
const { loadLang } = require('tesseract.js-utils');
const dump = require('./utils/dump');
const isBrowser = require('../utils/getEnvironment')('type') === 'browser';
const setImage = require('./utils/setImage');
const getFiles = require('./utils/getFiles');
const defaultParams = require('./constants/defaultParams');

/*
 * Tesseract Module returned by TesseractCore.
 */
let TessModule;
/*
 * TessearctBaseAPI instance
 */
let api;
let latestJob;
let adapter = {};
let params = defaultParams;


/**
 * handleInit
 *
 * @name handleInit
 * @function handle initialization of TessModule
 * @access public
 * @param {object} req - job payload
 * @param {string} req.corePath - path to the tesseract-core.js
 * @param {object} res - job instance
 * @returns {Promise} A Promise for callback
 */
const load = ({ workerId, jobId, payload: { options: { corePath } } }, res) => {
  if (!TessModule) {
    const Core = adapter.getCore(corePath, res);

    res.progress({ workerId, status: 'initializing tesseract', progress: 0 });

    Core({
      TesseractProgress(percent) {
        latestJob.progress({
          workerId,
          jobId,
          status: 'recognizing text',
          progress: Math.max(0, (percent - 30) / 70),
        });
      },
    })
      .then((tessModule) => {
        TessModule = tessModule;
        res.progress({ workerId, status: 'initialized tesseract', progress: 1 });
        res.resolve({ loaded: true });
      });
  } else {
    res.resolve({ loaded: true });
  }
};

/**
 * loadLanguage
 *
 * @name loadLanguage
 * @function load language from remote or local cache
 * @access public
 * @param {object} req - job payload
 * @param {string} req.langs - languages to load, ex: eng, eng+chi_tra
 * @param {object} req.options - other options for loadLang function
 * @param {object} res - job instance
 * @returns {Promise} A Promise for callback
 */
const loadLanguage = ({ workerId, payload: { langs, options } }, res) => {
  res.progress({ workerId, status: 'loading language traineddata', progress: 0 });
  loadLang({ langs, TessModule, ...options }).then(() => {
    res.progress({ workerId, status: 'loaded language traineddata', progress: 1 });
    res.resolve(langs);
  }).catch((err) => {
    if (isBrowser && err instanceof DOMException) {
      /*
       * For some reason google chrome throw DOMException in loadLang,
       * while other browser is OK, for now we ignore this exception
       * and hopefully to find the root cause one day.
       */
    } else {
      res.reject(err.toString());
    }
  });
};

const setParameters = ({ payload: { params: _params } }, res) => {
  Object.keys(_params)
    .filter(k => !k.startsWith('tessjs_'))
    .forEach((key) => {
      api.SetVariable(key, _params[key]);
    });
  params = { ...params, ..._params };

  if (typeof res !== 'undefined') {
    res.resolve(params);
  }
};

const initialize = ({
  workerId,
  jobId,
  payload: { langs: _langs, oem },
}, res) => {
  const langs = (typeof _langs === 'string')
    ? _langs
    : _langs.map(l => ((typeof l === 'string') ? l : l.data)).join('+');

  try {
    res.progress({
      workerId, jobId, status: 'initializing api', progress: 0,
    });
    api = new TessModule.TessBaseAPI();
    api.Init(null, langs, oem);
    setParameters({ payload: { params } });
    res.progress({
      workerId, jobId, status: 'initialized api', progress: 1,
    });
    res.resolve();
  } catch (err) {
    res.reject(err.toString());
  }
};

/**
 * handleRecognize
 *
 * @name handleRecognize
 * @function handle recognition job
 * @access public
 * @param {object} req - job payload
 * @param {array} req.image - binary image in array format
 * @param {string} req.langs - languages to load, ex: eng, eng+chi_tra
 * @param {object} req.options - other options for loadLang function
 * @param {object} req.params - parameters for tesseract
 * @param {object} res - job instance
 */
const recognize = ({ payload: { image } }, res) => {
  try {
    const ptr = setImage(TessModule, api, image, params);
    api.Recognize(null);
    res.resolve({
      files: getFiles(TessModule, api, adapter, params),
      ...dump(TessModule, api, params),
    });
    TessModule._free(ptr);
  } catch (err) {
    res.reject(err.toString());
  }
};

/**
 * handleDetect
 *
 * @name handleDetect
 * @function handle detect (Orientation and Script Detection / OSD) job
 * @access public
 * @param {object} req - job payload
 * @param {array} req.image - binary image in array format
 * @param {string} req.langs - languages to load, ex: eng, eng+chi_tra
 * @param {object} req.options - other options for loadLang function
 * @param {object} res - job instance
 */
const detect = ({ payload: { image } }, res) => {
  try {
    const ptr = setImage(TessModule, api, image, params);
    const results = new TessModule.OSResults();

    if (!api.DetectOS(results)) {
      api.End();
      TessModule._free(ptr);
      res.reject('Failed to detect OS');
    } else {
      const best = results.best_result;
      const oid = best.orientation_id;
      const sid = best.script_id;

      TessModule._free(ptr);

      res.resolve({
        tesseract_script_id: sid,
        script: results.unicharset.get_script_from_script_id(sid),
        script_confidence: best.sconfidence,
        orientation_degrees: [0, 270, 180, 90][oid],
        orientation_confidence: best.oconfidence,
      });
    }
  } catch (err) {
    res.reject(err.toString());
  }
};

const terminate = (_, res) => {
  try {
    api.End();
    res.resolve({ terminated: true });
  } catch (err) {
    res.reject(err.toString());
  }
};

/**
 * dispatchHandlers
 *
 * @name dispatchHandlers
 * @function worker data handler
 * @access public
 * @param {object} data
 * @param {string} data.jobId - unique job id
 * @param {string} data.action - action of the job, only recognize and detect for now
 * @param {object} data.payload - data for the job
 * @param {function} send - trigger job to work
 */
exports.dispatchHandlers = (packet, send) => {
  const res = (status, data) => {
    send({
      ...packet,
      status,
      data,
    });
  };
  res.resolve = res.bind(this, 'resolve');
  res.reject = res.bind(this, 'reject');
  res.progress = res.bind(this, 'progress');

  latestJob = res;

  try {
    const { action } = packet;
    if (action === 'load') {
      load(packet, res);
    } else if (action === 'load-language') {
      loadLanguage(packet, res);
    } else if (action === 'initialize') {
      initialize(packet, res);
    } else if (action === 'set-parameters') {
      setParameters(packet, res);
    } else if (action === 'recognize') {
      recognize(packet, res);
    } else if (action === 'detect') {
      detect(packet, res);
    } else if (action === 'terminate') {
      terminate(packet, res);
    }
  } catch (err) {
    /** Prepare exception to travel through postMessage */
    res.reject(err.toString());
  }
};

/**
 * setAdapter
 *
 * @name setAdapter
 * @function
 * @access public
 * @param {object} adapter - implementation of the worker, different in browser and node environment
 */
exports.setAdapter = (_adapter) => {
  adapter = _adapter;
};