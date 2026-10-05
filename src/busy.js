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
function writeAtomic(f, text, opts) {
  var fs = require('fs');
  var kept = opts && opts.preserveDamaged ? preserveDamaged(f, opts.shape) : null;
  var tmp = f + '.' + process.pid + '.' + require('crypto').randomBytes(3).toString('hex') + '.tmp';
  try {
    fs.writeFileSync(tmp, text);
    retry(function () { fs.renameSync(tmp, f); });
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (ignore) { /* only this write's own file */ }
    throw e;
  }
  return kept;
}

/* A state file that cannot be read is read as empty by the code that owns it, and its next write replaces it: the record is gone, with no copy. So before a write replaces a
 * file that exists and is damaged (not JSON, or not the kind of value the file holds: `shape` is 'object' or 'array'), the damaged file is copied, whole, to a name that cannot collide
 * with an earlier one, as status.json always was. A file that is absent, empty, or merely unreadable at this moment is not judged. Returns the copy's path, or null. */
function preserveDamaged(f, shape) {
  var fs = require('fs'), raw;
  try { raw = fs.readFileSync(f, 'utf8'); } catch (e) { return null; }
  if (!raw.trim()) return null;
  var ok = false;
  try {
    var v = JSON.parse(raw.replace(/^\uFEFF/, ''));
    ok = !!v && typeof v === 'object' && (shape === 'array' ? Array.isArray(v) : shape === 'object' ? !Array.isArray(v) : true);
  } catch (e) { ok = false; }
  if (ok) return null;
  var stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 13);
  for (var i = 0; i < 20; i++) {
    var copy = f + '.damaged-' + stamp + '-' + require('crypto').randomBytes(4).toString('hex');
    try { fs.copyFileSync(f, copy, fs.constants.COPYFILE_EXCL); return copy; }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  throw new Error('could not find an unused name to preserve the damaged file ' + f + ' under');
}

module.exports = { retry: retry, writeAtomic: writeAtomic, preserveDamaged: preserveDamaged };
