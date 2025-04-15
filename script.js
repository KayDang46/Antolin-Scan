let imageElement = document.getElementById('uploadedImage');
let resultsDiv = document.getElementById('results');
let ocrTextDiv = document.getElementById('ocrText');
let toggleOcrTextBtn = document.getElementById('toggleOcrText');
let loadingSpinner = document.getElementById('loadingSpinner');
let successMessage = document.getElementById('successMessage');

// Khởi tạo worker Tesseract.js
let worker = null;
async function initializeWorker() {
    worker = await Tesseract.createWorker('eng', 1, {
        workerPath: 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.0/dist/worker.min.js',
        corePath: 'https://cdn.jsdelivr.net/npm/tesseract.js-core@5.1.0/tesseract-core.wasm.js',
    });
    await worker.setParameters({
        tessedit_char_whitelist: 'BIN0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ',
        tessedit_pagesegmode: 4,
        preserve_interword_spaces: 0,
        tessedit_ocr_engine_mode: 1,
    });
}
initializeWorker();

// Xử lý tải hình ảnh
document.getElementById('imageUpload').addEventListener('change', handleImage);
document.getElementById('cameraInput').addEventListener('change', handleImage);

function handleImage(event) {
    let file = event.target.files[0];
    if (file) {
        let reader = new FileReader();
        reader.onload = function(e) {
            imageElement.src = e.target.result;
            imageElement.style.display = 'block';
        };
        reader.readAsDataURL(file);
    }
}

// Tiền xử lý hình ảnh
function preprocessImage(imageSrc) {
    return new Promise((resolve) => {
        const img = new Image();
        img.crossOrigin = "Anonymous";
        img.src = imageSrc;
        img.onload = () => {
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d', { willReadFrequently: true });

            let width = img.width;
            let height = img.height;
            const targetDPI = 300;
            const minWidth = Math.round(targetDPI * (img.width / 96));
            if (width < minWidth) {
                const scale = minWidth / width;
                width = minWidth;
                height = height * scale;
            }
            canvas.width = width;
            canvas.height = height;
            ctx.drawImage(img, 0, 0, width, height);

            let imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            let data = imageData.data;

            for (let i = 0; i < data.length; i += 4) {
                const r = data[i];
                const g = data[i + 1];
                const b = data[i + 2];
                const grayscale = 0.2989 * r + 0.5870 * g + 0.1140 * b;
                data[i] = grayscale;
                data[i + 1] = grayscale;
                data[i + 2] = grayscale;
            }

            ctx.putImageData(imageData, 0, 0);
            ctx.filter = 'blur(0.8px)';
            ctx.drawImage(canvas, 0, 0);
            imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            data = imageData.data;

            const threshold = 105;
            for (let i = 0; i < data.length; i += 4) {
                const brightness = data[i];
                const contrast = (brightness - 128) * 3 + 128;
                const adjusted = Math.max(0, Math.min(255, contrast));
                const value = adjusted > threshold ? 255 : 0;
                data[i] = value;
                data[i + 1] = value;
                data[i + 2] = value;
            }

            ctx.putImageData(imageData, 0, 0);
            resolve(canvas.toDataURL());
        };
    });
}

async function scanImage() {
    if (!imageElement.src) {
        alert('Vui lòng chụp ảnh hoặc tải hình ảnh lên trước.');
        return;
    }

    resultsDiv.innerHTML = '';
    loadingSpinner.style.display = 'block';
    if (toggleOcrTextBtn) toggleOcrTextBtn.style.display = 'none';
    if (successMessage) successMessage.classList.remove('visible');

    const processedImage = await preprocessImage(imageElement.src);

    let parts = {};
    try {
        if (!worker) {
            await initializeWorker();
        }

        const { data: { text, words } } = await worker.recognize(processedImage, { text: true, words: true });

        if (ocrTextDiv) {
            ocrTextDiv.textContent = text;
            ocrTextDiv.style.display = 'none';
        }
        console.log('OCR text:', text);

        let correctedText = text;
        correctedText = correctedText.replace(/(?<=BIN)[0O](?=\d{5,8}[A-Z]{2,5})/g, '0');
        correctedText = correctedText.replace(/(?<=BIN\d)[I1](?=\d{4,7}[A-Z]{2,5})/g, '1');
        correctedText = correctedText.replace(/(?<=BIN\d{2})[S5](?=\d{3,6}[A-Z]{2,5})/g, '5');
        correctedText = correctedText.replace(/(?<=BIN\d{3})[B8](?=\d{2,5}[A-Z]{2,5})/g, '8');
        correctedText = correctedText.replace(/(?<=BIN\d{4})[Z2](?=\d{1,4}[A-Z]{2,5})/g, '2');
        correctedText = correctedText.replace(/(?<=BIN\d{6,9})[0O](?=[A-Z]{1,4})/g, 'O');
        correctedText = correctedText.replace(/(?<=BIN\d{6,9}[A-Z])[I1](?=[A-Z]{0,3})/g, 'I');

        const textLines = correctedText.split('\n').filter(line => line.trim() !== '');

        for (const line of textLines) {
            const trimmedLine = line.trim();
            if (trimmedLine.includes('PART NUMBER')) continue;

            const columns = trimmedLine.split(/\s+/).filter(col => col.trim() !== '');

            if (columns.length >= 5) {
                let partNumber = columns[3];
                let match = partNumber.match(/BIN\d{6,9}[A-Z]{2,5}\b/);
                if (match) {
                    parts[partNumber] = (parts[partNumber] || 0) + 1;
                    console.log(`Found part number in table row: ${partNumber}`);
                }
            }
        }

        if (Object.keys(parts).length === 0) {
            let matches = correctedText.match(/BIN\d{6,9}[A-Z]{2,5}\b/g);
            if (matches) {
                matches.forEach(partNumber => {
                    parts[partNumber] = (parts[partNumber] || 0) + 1;
                    console.log(`Found part number in free text: ${partNumber}`);
                });
            }
        }

        let confidentParts = {};
        words.forEach(word => {
            if (word.confidence > 80) {
                let match = word.text.match(/BIN\d{6,9}[A-Z]{2,5}\b/);
                if (match && parts[word.text]) {
                    confidentParts[word.text] = parts[word.text];
                    console.log(`Confident part number: ${word.text} (confidence: ${word.confidence})`);
                }
            }
        });

        if (Object.keys(confidentParts).length > 0) {
            parts = confidentParts;
        }
    } catch (error) {
        console.error('Lỗi khi quét OCR:', error);
        resultsDiv.innerHTML = 'Đã xảy ra lỗi khi quét hình ảnh.';
        return;
    } finally {
        loadingSpinner.style.display = 'none';
        if (toggleOcrTextBtn) toggleOcrTextBtn.style.display = 'block';
        if (successMessage) successMessage.classList.add('visible');
    }

    displayResults(parts);
}

function displayResults(parts) {
    resultsDiv.innerHTML = '<h2>Kết quả</h2>';
    if (Object.keys(parts).length === 0) {
        resultsDiv.innerHTML += '<p>Không tìm thấy part number nào.</p>';
    } else {
        let table = '<table><tr><th>Part Number</th><th>Số Lượng</th></tr>';
        for (let part in parts) {
            table += `<tr><td>${part}</td><td>${parts[part]}</td></tr>`;
        }
        table += '</table>';
        resultsDiv.innerHTML += table;
        setTimeout(() => {
            const resultTable = resultsDiv.querySelector('table');
            if (resultTable) resultTable.classList.add('visible');
        }, 0);
    }
}

function toggleOcrText() {
    if (ocrTextDiv.style.display === 'none') {
        ocrTextDiv.style.display = 'block';
        toggleOcrTextBtn.innerHTML = '<i class="fas fa-eye-slash"></i> Ẩn văn bản OCR';
    } else {
        ocrTextDiv.style.display = 'none';
        toggleOcrTextBtn.innerHTML = '<i class="fas fa-eye"></i> Hiển thị văn bản OCR';
    }
}