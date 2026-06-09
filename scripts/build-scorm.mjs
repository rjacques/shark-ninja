import { promises as fs } from 'node:fs';
import path from 'node:path';

const rootDir = process.cwd();
const distDir = path.join(rootDir, 'dist');
const scormDir = path.join(distDir, 'scorm');

function toPosix(value) {
  return value.replace(/\\/g, '/');
}

function slugify(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'course';
}

function escapeXml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function walk(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walk(fullPath));
    } else {
      files.push(fullPath);
    }
  }

  return files;
}

function getPrefixForHtml(htmlFile) {
  const htmlDir = path.dirname(htmlFile);
  const relToDist = toPosix(path.relative(htmlDir, distDir));
  return relToDist ? `${relToDist}/` : './';
}

function rewriteRootRelativeUrls(html, prefix) {
  return html
    .replace(/(href=)(["'])\/(?!\/)/g, `$1$2${prefix}`)
    .replace(/(src=)(["'])\/(?!\/)/g, `$1$2${prefix}`)
    .replace(/url\((["']?)\/(?!\/)/g, `url($1${prefix}`);
}

async function readConfig() {
  const moduleName = path.basename(rootDir);
  const packageJsonPath = path.join(rootDir, 'package.json');

  let packageJson = {};
  if (await exists(packageJsonPath)) {
    packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));
  }

  const scormConfig = packageJson.scorm || {};
  const courseTitle = scormConfig.courseTitle || 'eLearning';
  const courseId = scormConfig.courseId || slugify(moduleName);
  const launchFile = scormConfig.launchFile || 'index.html';
  const scormVersion = scormConfig.version || '1.2';
  const completeOnLoad = scormConfig.completeOnLoad !== false;

  return {
    courseTitle,
    courseId,
    launchFile,
    scormVersion,
    completeOnLoad
  };
}

function buildRuntimeScript() {
  return `(function () {
  var config = window.__SCORM_CONFIG__ || {};
  var version = config.version === "2004" ? "2004" : "1.2";
  var startTime = Date.now();
  var initialized = false;
  var finishCalled = false;
  var processedUnload = false;
  var API = null;

  var methods = version === "2004"
    ? {
        apiName: "API_1484_11",
        initialize: "Initialize",
        finish: "Terminate",
        get: "GetValue",
        set: "SetValue",
        commit: "Commit",
        getLastError: "GetLastError",
        getErrorString: "GetErrorString",
        getDiagnostic: "GetDiagnostic",
        location: "cmi.location",
        suspendData: "cmi.suspend_data",
        completion: "cmi.completion_status",
        success: "cmi.success_status",
        scoreRaw: "cmi.score.raw",
        scoreMin: "cmi.score.min",
        scoreMax: "cmi.score.max",
        sessionTime: "cmi.session_time",
        exit: "cmi.exit"
      }
    : {
        apiName: "API",
        initialize: "LMSInitialize",
        finish: "LMSFinish",
        get: "LMSGetValue",
        set: "LMSSetValue",
        commit: "LMSCommit",
        getLastError: "LMSGetLastError",
        getErrorString: "LMSGetErrorString",
        getDiagnostic: "LMSGetDiagnostic",
        location: "cmi.core.lesson_location",
        suspendData: "cmi.suspend_data",
        completion: "cmi.core.lesson_status",
        success: null,
        scoreRaw: "cmi.core.score.raw",
        scoreMin: "cmi.core.score.min",
        scoreMax: "cmi.core.score.max",
        sessionTime: "cmi.core.session_time",
        exit: "cmi.core.exit"
      };

  function log(level, message, details) {
    var logger = console[level] || console.log;
    if (details === undefined) {
      logger.call(console, "[SCORM] " + message);
    } else {
      logger.call(console, "[SCORM] " + message, details);
    }
  }

  function isSuccess(value) {
    return value === true || value === "true" || value === "1" || value === 1;
  }

  function safeApiLookup(win, apiName) {
    try {
      return win && win[apiName] ? win[apiName] : null;
    } catch {
      return null;
    }
  }

  function findAPI(win, apiName) {
    var tries = 0;

    while (!safeApiLookup(win, apiName) && win && win.parent && win.parent !== win) {
      tries += 1;

      if (tries > 7) {
        log("warn", "Error finding API: too deeply nested.");
        return null;
      }

      try {
        win = win.parent;
      } catch {
        return null;
      }
    }

    return safeApiLookup(win, apiName);
  }

  function getAPI() {
    if (API) {
      return API;
    }

    API = findAPI(window, methods.apiName);

    if (!API) {
      try {
        if (window.opener && typeof window.opener !== "undefined") {
          API = findAPI(window.opener, methods.apiName);
        }
      } catch {
        API = null;
      }
    }

    if (!API) {
      log("warn", "Unable to find an API adapter.");
    }

    return API;
  }

  function callApi(methodName, args, fallback) {
    var apiHandle = getAPI();
    if (!apiHandle || typeof apiHandle[methodName] !== "function") {
      return fallback;
    }

    try {
      return apiHandle[methodName].apply(apiHandle, args || []);
    } catch (error) {
      log("warn", methodName + " threw an error.", error);
      return fallback;
    }
  }

  function getErrorInfo() {
    if (!getAPI()) {
      return null;
    }

    var code = String(callApi(methods.getLastError, [], "0"));

    return {
      code: code,
      message: String(callApi(methods.getErrorString, [code], "")),
      diagnostic: String(callApi(methods.getDiagnostic, [code], ""))
    };
  }

  function reportApiError(action) {
    var info = getErrorInfo();
    if (!info || info.code === "0") {
      return;
    }

    log("warn", action + " failed (" + info.code + "): " + info.message, info.diagnostic);
  }

  function convertMillisecondsToScorm12Time(totalMilliseconds) {
    var milliseconds = totalMilliseconds % 1000;
    var seconds = Math.floor((totalMilliseconds / 1000) % 60);
    var minutes = Math.floor((totalMilliseconds / 60000) % 60);
    var hours = Math.floor(totalMilliseconds / 3600000);
    var hundredths = Math.floor(milliseconds / 10);

    function pad(value, length) {
      return String(value).padStart(length, "0");
    }

    if (hours > 9999) {
      return "9999:99:99.99";
    }

    return pad(hours, 4) + ":" + pad(minutes, 2) + ":" + pad(seconds, 2) + "." + pad(hundredths, 2);
  }

  function convertMillisecondsToScorm2004Time(totalMilliseconds) {
    var remaining = Math.max(0, totalMilliseconds);
    var hours = Math.floor(remaining / 3600000);
    remaining -= hours * 3600000;
    var minutes = Math.floor(remaining / 60000);
    remaining -= minutes * 60000;
    var seconds = remaining / 1000;
    var text = "PT";

    if (hours > 0) {
      text += hours + "H";
    }

    if (minutes > 0) {
      text += minutes + "M";
    }

    text += seconds.toFixed(2).replace(/\\.00$/, "") + "S";
    return text;
  }

  function getSessionTime() {
    var elapsed = Date.now() - startTime;
    return version === "2004"
      ? convertMillisecondsToScorm2004Time(elapsed)
      : convertMillisecondsToScorm12Time(elapsed);
  }

  function ensureInitialized() {
    if (initialized) {
      return true;
    }

    if (!getAPI()) {
      return false;
    }

    var result = callApi(methods.initialize, [""], "false");
    if (!isSuccess(result)) {
      reportApiError("Initialize");
      return false;
    }

    initialized = true;
    return true;
  }

  function rawGetValue(element) {
    if (!ensureInitialized()) {
      return "";
    }

    var result = callApi(methods.get, [element], "");
    if (result === "") {
      var info = getErrorInfo();
      if (info && info.code !== "0") {
        reportApiError("GetValue " + element);
      }
    }

    return String(result);
  }

  function rawSetValue(element, value) {
    if (!ensureInitialized()) {
      return false;
    }

    var result = callApi(methods.set, [element, String(value)], "false");
    if (!isSuccess(result)) {
      reportApiError("SetValue " + element);
      return false;
    }

    return true;
  }

  function rawCommit() {
    if (!ensureInitialized()) {
      return false;
    }

    var result = callApi(methods.commit, [""], "false");
    if (!isSuccess(result)) {
      reportApiError("Commit");
      return false;
    }

    return true;
  }

  function getCompletionStatus() {
    return rawGetValue(methods.completion);
  }

  function isTerminalStatus(status) {
    if (version === "2004") {
      return status === "completed";
    }

    return status === "completed" || status === "passed" || status === "failed";
  }

  function syncLocation() {
    var bookmark = location.pathname + location.search + location.hash;
    rawSetValue(methods.location, bookmark);
  }

  function syncSessionTime() {
    rawSetValue(methods.sessionTime, getSessionTime());
  }

  function restoreBookmark() {
    var bookmark = rawGetValue(methods.location);
    var hashIndex = bookmark.indexOf("#");

    if (hashIndex === -1) {
      return;
    }

    var storedHash = bookmark.slice(hashIndex);
    if (storedHash && storedHash !== "#" && storedHash !== location.hash) {
      location.hash = storedHash;
    }
  }

  function ensureIncompleteStatus() {
    var status = getCompletionStatus();

    if (version === "2004") {
      if (status === "" || status === "not attempted" || status === "unknown") {
        rawSetValue(methods.completion, "incomplete");
        rawCommit();
      }
      return;
    }

    if (status === "" || status === "not attempted") {
      rawSetValue(methods.completion, "incomplete");
      rawCommit();
    }
  }

  var CourseSCORM = {
    init: function () {
      if (!ensureInitialized()) {
        return false;
      }

      restoreBookmark();

      if (config.completeOnLoad !== false) {
        var completed = this.complete();
        if (completed) {
          log("info", "Marked course complete on launch.");
        }
        return completed;
      }

      ensureIncompleteStatus();
      syncLocation();
      rawCommit();
      return true;
    },

    get: function (name) {
      return rawGetValue(name);
    },

    set: function (name, value) {
      return rawSetValue(name, value);
    },

    save: function () {
      syncLocation();
      return rawCommit();
    },

    getLocation: function () {
      return rawGetValue(methods.location);
    },

    setLocation: function (value) {
      return rawSetValue(methods.location, value);
    },

    getSuspendData: function () {
      return rawGetValue(methods.suspendData);
    },

    setSuspendData: function (value) {
      return rawSetValue(methods.suspendData, value);
    },

    setScore: function (raw, min, max) {
      var safeMin = min == null ? 0 : min;
      var safeMax = max == null ? 100 : max;

      return rawSetValue(methods.scoreRaw, raw) &&
        rawSetValue(methods.scoreMin, safeMin) &&
        rawSetValue(methods.scoreMax, safeMax) &&
        rawCommit();
    },

    complete: function () {
      if (!ensureInitialized()) {
        return false;
      }

      var ok = rawSetValue(methods.completion, "completed");
      if (!ok) {
        return false;
      }

      syncLocation();
      return rawCommit();
    },

    pass: function () {
      if (!ensureInitialized()) {
        return false;
      }

      var ok = rawSetValue(methods.completion, version === "2004" ? "completed" : "passed");
      if (!ok) {
        return false;
      }

      if (methods.success) {
        ok = rawSetValue(methods.success, "passed") && ok;
      }

      syncLocation();
      return ok && rawCommit();
    },

    fail: function () {
      if (!ensureInitialized()) {
        return false;
      }

      var ok = rawSetValue(methods.completion, version === "2004" ? "completed" : "failed");
      if (!ok) {
        return false;
      }

      if (methods.success) {
        ok = rawSetValue(methods.success, "failed") && ok;
      }

      syncLocation();
      return ok && rawCommit();
    },

    finish: function (exitValue) {
      if (finishCalled) {
        return true;
      }

      if (!ensureInitialized()) {
        return false;
      }

      syncLocation();
      syncSessionTime();

      var completionStatus = getCompletionStatus();
      var resolvedExitValue = exitValue;

      if (resolvedExitValue == null) {
        resolvedExitValue = isTerminalStatus(completionStatus) ? "" : "suspend";
      }

      rawSetValue(methods.exit, resolvedExitValue);
      rawCommit();

      var result = callApi(methods.finish, [""], "false");
      if (!isSuccess(result)) {
        reportApiError("Finish");
        return false;
      }

      finishCalled = true;
      initialized = false;
      return true;
    },

    completeAndFinish: function () {
      var completed = this.complete();
      var finished = this.finish("");
      return completed && finished;
    }
  };

  window.CourseSCORM = CourseSCORM;

  function handleUnload() {
    if (processedUnload) {
      return;
    }

    processedUnload = true;
    CourseSCORM.finish();
  }

  if (config.autoInitialize !== false) {
    window.addEventListener("load", function () {
      CourseSCORM.init();
    }, { once: true });
  }

  window.addEventListener("hashchange", function () {
    if (!finishCalled) {
      syncLocation();
      rawCommit();
    }
  });

  window.addEventListener("beforeunload", handleUnload);
  window.addEventListener("unload", handleUnload);
})();`;
}

function buildManifest({ courseTitle, courseId, launchFile, allFiles }) {
  const fileNodes = allFiles
    .filter((file) => file !== 'imsmanifest.xml')
    .filter((file) => !file.toLowerCase().endsWith('.zip'))
    .map((file) => `      <file href="${escapeXml(file)}" />`)
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<manifest
  identifier="${escapeXml(courseId)}"
  version="1.0"
  xmlns="http://www.imsproject.org/xsd/imscp_rootv1p1p2"
  xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_rootv1p2"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="
    http://www.imsproject.org/xsd/imscp_rootv1p1p2 imscp_rootv1p1p2.xsd
    http://www.adlnet.org/xsd/adlcp_rootv1p2 adlcp_rootv1p2.xsd">

  <metadata>
    <schema>ADL SCORM</schema>
    <schemaversion>1.2</schemaversion>
  </metadata>

  <organizations default="ORG-1">
    <organization identifier="ORG-1">
      <title>${escapeXml(courseTitle)}</title>
      <item identifier="ITEM-1" identifierref="RES-1" isvisible="true">
        <title>${escapeXml(courseTitle)}</title>
      </item>
    </organization>
  </organizations>

  <resources>
    <resource
      identifier="RES-1"
      type="webcontent"
      adlcp:scormtype="sco"
      href="${escapeXml(launchFile)}">
${fileNodes}
    </resource>
  </resources>
</manifest>`;
}

async function injectIntoHtml(htmlFile, config) {
  const prefix = getPrefixForHtml(htmlFile);

  const snippet = [
    `<script>window.__SCORM_CONFIG__ = { version: ${JSON.stringify(config.scormVersion)}, autoInitialize: true, completeOnLoad: ${config.completeOnLoad ? 'true' : 'false'} };</script>`,
    `<script src="${prefix}scorm/scorm-runtime.js"></script>`
  ].join('\n');

  let html = await fs.readFile(htmlFile, 'utf8');
  html = rewriteRootRelativeUrls(html, prefix);

  html = html
    .replace(/<script>window\.__SCORM_CONFIG__[\s\S]*?<\/script>\s*/g, '')
    .replace(/<script src="[^"]*scorm\/SCORM_API_wrapper\.js"><\/script>\s*/g, '')
    .replace(/<script src="[^"]*scorm\/scorm-adapter\.js"><\/script>\s*/g, '')
    .replace(/<script src="[^"]*scorm\/scorm-runtime\.js"><\/script>\s*/g, '');

  if (html.includes('</head>')) {
    html = html.replace('</head>', `${snippet}\n</head>`);
  } else {
    html = `${snippet}\n${html}`;
  }

  await fs.writeFile(htmlFile, html, 'utf8');
}

async function main() {
  if (!(await exists(distDir))) {
    throw new Error('dist folder not found. Run npm run build first.');
  }

  const config = await readConfig();

  await fs.mkdir(scormDir, { recursive: true });
  await fs.rm(path.join(scormDir, 'SCORM_API_wrapper.js'), { force: true });
  await fs.rm(path.join(scormDir, 'scorm-adapter.js'), { force: true });
  await fs.writeFile(path.join(scormDir, 'scorm-runtime.js'), buildRuntimeScript(), 'utf8');

  const absoluteFiles = await walk(distDir);

  for (const file of absoluteFiles) {
    if (file.toLowerCase().endsWith('.html')) {
      await injectIntoHtml(file, config);
    }
  }

  const updatedFiles = await walk(distDir);
  const relativeFiles = updatedFiles.map((file) => toPosix(path.relative(distDir, file)));

  const manifest = buildManifest({
    courseTitle: config.courseTitle,
    courseId: config.courseId,
    launchFile: config.launchFile,
    allFiles: relativeFiles
  });

  await fs.writeFile(path.join(distDir, 'imsmanifest.xml'), manifest, 'utf8');

  console.log(`SCORM assets written for ${config.courseTitle}.`);
  console.log('Manifest written to dist/imsmanifest.xml');
  console.log('Package the contents of dist/ as a ZIP for LMS upload.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
