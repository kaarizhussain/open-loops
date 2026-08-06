/* Builds index.html: inlines the engine, the demo data, and the fonts.
 * Fonts are downloaded on first run and cached in fonts/ — no manual setup. */
var fs = require('fs');
var path = require('path');

var ROOT = __dirname;
var FONT_DIR = path.join(ROOT, 'fonts');

var FONTS = {
  NEWSREADER: 'https://fonts.gstatic.com/s/newsreader/v26/cY9AfjOCX1hbuyalUrK4397yjA.woff2',
  PUBLICSANS: 'https://fonts.gstatic.com/s/publicsans/v21/ijwRs572Xtc6ZYQws9YVwnNGfJ4.woff2',
  MONO400: 'https://fonts.gstatic.com/s/ibmplexmono/v20/-F63fjptAgt5VM-kVkqdyU8n1i8q1w.woff2',
  MONO600: 'https://fonts.gstatic.com/s/ibmplexmono/v20/-F6qfjptAgt5VM-kVkqdyU8n3vAOwlBFgg.woff2'
};

async function font(key) {
  var file = path.join(FONT_DIR, key + '.woff2');
  if (!fs.existsSync(file)) {
    process.stdout.write('  fetching ' + key + '… ');
    var res = await fetch(FONTS[key], { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) throw new Error('font download failed for ' + key + ': HTTP ' + res.status);
    fs.mkdirSync(FONT_DIR, { recursive: true });
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    console.log('ok');
  }
  return fs.readFileSync(file).toString('base64');
}

/* Same files Node requires for the tests, minus the CommonJS export tail. */
function source(f) {
  return fs.readFileSync(path.join(ROOT, 'src', f), 'utf8').replace(/if \(typeof module[\s\S]*$/, '');
}

(async function () {
  var html = fs.readFileSync(path.join(ROOT, 'src', 'digest.tpl.html'), 'utf8');
  for (var key of Object.keys(FONTS)) html = html.replace('__' + key + '__', await font(key));
  html = html
    .replace('__LOOPS_JS__', function () { return source('loops.js'); })
    .replace('__FIXTURE_JS__', function () { return source('fixture.js'); });

  var left = html.match(/__[A-Z_]+__/);
  if (left) throw new Error('unsubstituted placeholder: ' + left[0]);

  var out = path.join(ROOT, 'index.html');
  fs.writeFileSync(out, html);
  console.log('built index.html (' + (html.length / 1024).toFixed(0) + ' KB) — open it in a browser');
})();
