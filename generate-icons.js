const fs = require('fs');
const { createCanvas } = require('canvas');

// Icon boyutları
const sizes = [192, 512];

// Her boyut için icon oluştur
sizes.forEach(size => {
    const canvas = createCanvas(size, size);
    const ctx = canvas.getContext('2d');

    // Arka plan
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, size, size);

    // Metin
    ctx.fillStyle = '#FFFFFF';
    ctx.font = `${size/4}px Arial`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('KIOSK', size/2, size/2);

    // PNG olarak kaydet
    const buffer = canvas.toBuffer('image/png');
    fs.writeFileSync(`icons/icon-${size}x${size}.png`, buffer);
    console.log(`${size}x${size} icon oluşturuldu`);
}); 