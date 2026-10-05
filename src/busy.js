/* Retry a file operation that fails only because another process has the file open.
 *
 * On Windows a rename over a file that a reader holds fails with EPERM/EBUSY/EACCES instead of
 * waiting. A digest run makes several full-file flushes, so one overlapping reader (a check, an
 * antivirus scan, an editor) used to abort it partway. Anything else is thrown at once. */
var BUSY = { EPERM: 1, EBUSY: 1, EACCES: 1 };

function retry(fn) {
  for (var i = 0; ; i++) {
    try { return fn(); } catch (e) {
      if (!BUSY[e.code] || i >= 40) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5 + i);
    }
  }
}

/* Write a file so that a reader, or a crash, sees the old content or the new, whole: into a file of its own beside it, then renamed over. A plain
 * writeFileSync truncates first, so a run killed midway leaves the user's config, or the report queue, half written. */
function writeAtomic(f, text) {
  var fs = require('fs');
  var tmp = f + '.' + process.pid + '.' + require('crypto').randomBytes(3).toString('hex') + '.tmp';
  try {
    fs.writeFileSync(tmp, text);
    retry(function () { fs.renameSync(tmp, f); });
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (ignore) { /* only this write's own file */ }
    throw e;
  }
}

module.exports = { retry: retry, writeAtomic: writeAtomic };
