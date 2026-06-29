const sharp = require('sharp');
const path = require('path');

const assetsDir = path.join(__dirname, '..', 'public', 'assets');
const logoPath = path.join(assetsDir, 'logo-oficial.png');

const BG_COLOR = { r: 251, g: 247, b: 239, alpha: 1 }; // #fbf7ef

async function gerarIcone(tamanhoCanvas, tamanhoLogo, nomeArquivo) {
    const offset = Math.round((tamanhoCanvas - tamanhoLogo) / 2);

    const logoRedimensionado = await sharp(logoPath)
        .resize(tamanhoLogo, tamanhoLogo, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png()
        .toBuffer();

    const destino = path.join(assetsDir, nomeArquivo);

    await sharp({
        create: {
            width: tamanhoCanvas,
            height: tamanhoCanvas,
            channels: 4,
            background: BG_COLOR
        }
    })
        .composite([{ input: logoRedimensionado, top: offset, left: offset }])
        .png()
        .toFile(destino);

    console.log(`✓ ${nomeArquivo} gerado (${tamanhoCanvas}x${tamanhoCanvas}px, logo ${tamanhoLogo}x${tamanhoLogo}px)`);
}

(async () => {
    try {
        await gerarIcone(192, 150, 'icon-192.png');
        await gerarIcone(512, 410, 'icon-512.png');
        console.log('\nIcones gerados com sucesso em public/assets/');
    } catch (err) {
        console.error('Erro ao gerar ícones:', err);
        process.exit(1);
    }
})();
