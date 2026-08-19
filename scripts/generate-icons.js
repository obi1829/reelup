/**
 * Rasterize assets/icon.svg → assets/icon.png (512) and multi-size assets/icon.ico (Windows).
 * Run: node scripts/generate-icons.js
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const pngToIco = require('png-to-ico').default;

const root = path.join(__dirname, '..');
const svgPath = path.join(root, 'assets', 'icon.svg');
const pngPath = path.join(root, 'assets', 'icon.png');
const icoPath = path.join(root, 'assets', 'icon.ico');

async function main() {
  const svg = fs.readFileSync(svgPath);

  await sharp(svg, { density: 450 })
    .resize(512, 512, { fit: 'contain', background: { r: 18, g: 21, b: 28, alpha: 1 } })
    .png()
    .toFile(pngPath);

  const sizes = [256, 128, 64, 48, 32, 16];
  const pngBuffers = await Promise.all(
    sizes.map((s) =>
      sharp(svg, { density: 450 })
        .resize(s, s, { fit: 'contain', background: { r: 18, g: 21, b: 28, alpha: 1 } })
        .png()
        .toBuffer()
    )
  );

  fs.writeFileSync(icoPath, await pngToIco(pngBuffers));
  console.log('Wrote', pngPath, 'and', icoPath);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
