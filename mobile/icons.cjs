// Render ikon launcher Android dari logo NexaISP (butuh Playwright + Chromium yang terpasang di server build).
const fs = require('fs');
const path = require('path');
const {chromium} = require(process.env.PLAYWRIGHT_PATH || '/usr/lib/node_modules/@playwright/cli/node_modules/playwright');

const res = process.argv[2];
const pulse = 'M10 33h11l7-18 9 34 7-16h10';
const legacy = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="16" fill="#0e8495"/><path d="${pulse}" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const round = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="32" fill="#0e8495"/><path d="${pulse}" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" transform="translate(5 5) scale(.85)"/></svg>`;
// Foreground adaptive icon 108dp: logo di dalam zona aman 66dp di tengah.
const foreground = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 108 108"><path d="${pulse}" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" transform="translate(22 22)"/></svg>`;
const densities = {mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4};

(async () => {
  const browser = await chromium.launch({executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox']});
  const page = await browser.newPage();
  const render = async (svg, size, file) => {
    await page.setViewportSize({width: size, height: size});
    await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
    fs.mkdirSync(path.dirname(file), {recursive: true});
    await page.screenshot({path: file, omitBackground: true, clip: {x: 0, y: 0, width: size, height: size}});
  };
  for (const [name, scale] of Object.entries(densities)) {
    const dir = path.join(res, 'mipmap-' + name);
    await render(legacy, Math.round(48 * scale), path.join(dir, 'ic_launcher.png'));
    await render(round, Math.round(48 * scale), path.join(dir, 'ic_launcher_round.png'));
    await render(foreground, Math.round(108 * scale), path.join(dir, 'ic_launcher_foreground.png'));
  }
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
