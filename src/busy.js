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

module.exports = { retry: retry };
