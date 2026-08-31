// === Avatar Cropper — modal de recorte com zoom, arrasto e preview ===
// Uso: openAvatarCropper(file).then(dataUrl => { ... }).catch(() => { /* cancelado */ });
// Sem dependências externas.
(function () {
  const OUTPUT_SIZE = 256;   // resolução final do avatar (quadrado)
  const VIEW_SIZE = 260;     // tamanho da área de recorte no modal (px)

  let modalEl = null;

  function buildModal() {
    if (modalEl) return modalEl;

    const overlay = document.createElement('div');
    overlay.className = 'cropper-modal';
    overlay.style.display = 'none';
    overlay.innerHTML = `
      <div class="cropper-content">
        <h3>Ajustar Foto</h3>
        <p class="cropper-hint">Arraste para posicionar e use o controle para dar zoom.</p>
        <div class="cropper-stage">
          <canvas class="cropper-canvas" width="${VIEW_SIZE}" height="${VIEW_SIZE}"></canvas>
          <div class="cropper-ring"></div>
        </div>
        <div class="cropper-zoom">
          <span>🔍−</span>
          <input type="range" class="cropper-zoom-range" min="1" max="4" step="0.01" value="1">
          <span>🔍+</span>
        </div>
        <div class="cropper-preview-row">
          <div class="cropper-preview" aria-label="Pré-visualização"></div>
          <span class="cropper-preview-label">Prévia</span>
        </div>
        <div class="cropper-actions">
          <button type="button" class="btn btn-outline cropper-cancel">Cancelar</button>
          <button type="button" class="btn btn-primary cropper-confirm">Usar foto</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    modalEl = overlay;
    return overlay;
  }

  function openAvatarCropper(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('Não consegui ler o arquivo.'));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error('Arquivo de imagem inválido.'));
        img.onload = () => startCrop(img, resolve, reject);
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  function startCrop(img, resolve, reject) {
    const overlay = buildModal();
    const canvas = overlay.querySelector('.cropper-canvas');
    const ctx = canvas.getContext('2d');
    const preview = overlay.querySelector('.cropper-preview');
    const zoomRange = overlay.querySelector('.cropper-zoom-range');
    const btnConfirm = overlay.querySelector('.cropper-confirm');
    const btnCancel = overlay.querySelector('.cropper-cancel');

    // Escala mínima: imagem cobre toda a área de recorte (cover)
    const baseScale = Math.max(VIEW_SIZE / img.width, VIEW_SIZE / img.height);
    let zoom = 1;
    let offsetX = 0; // deslocamento do centro da imagem em relação ao centro da view
    let offsetY = 0;

    zoomRange.value = '1';

    function currentScale() {
      return baseScale * zoom;
    }

    // Garante que a imagem sempre cubra a área (sem bordas vazias)
    function clampOffsets() {
      const scale = currentScale();
      const halfW = (img.width * scale) / 2;
      const halfH = (img.height * scale) / 2;
      const maxX = Math.max(0, halfW - VIEW_SIZE / 2);
      const maxY = Math.max(0, halfH - VIEW_SIZE / 2);
      offsetX = Math.min(maxX, Math.max(-maxX, offsetX));
      offsetY = Math.min(maxY, Math.max(-maxY, offsetY));
    }

    function draw() {
      clampOffsets();
      const scale = currentScale();
      const drawW = img.width * scale;
      const drawH = img.height * scale;
      const dx = (VIEW_SIZE - drawW) / 2 + offsetX;
      const dy = (VIEW_SIZE - drawH) / 2 + offsetY;

      ctx.clearRect(0, 0, VIEW_SIZE, VIEW_SIZE);
      ctx.drawImage(img, dx, dy, drawW, drawH);

      // Atualiza a prévia circular
      preview.style.backgroundImage = `url(${canvas.toDataURL('image/jpeg', 0.85)})`;
    }

    // Arrasto (mouse + toque)
    let dragging = false;
    let lastX = 0;
    let lastY = 0;

    function pointerDown(e) {
      dragging = true;
      const pt = getPoint(e);
      lastX = pt.x;
      lastY = pt.y;
    }
    function pointerMove(e) {
      if (!dragging) return;
      const pt = getPoint(e);
      offsetX += pt.x - lastX;
      offsetY += pt.y - lastY;
      lastX = pt.x;
      lastY = pt.y;
      draw();
      if (e.cancelable) e.preventDefault();
    }
    function pointerUp() {
      dragging = false;
    }
    function getPoint(e) {
      if (e.touches && e.touches[0]) {
        return { x: e.touches[0].clientX, y: e.touches[0].clientY };
      }
      return { x: e.clientX, y: e.clientY };
    }

    function onZoom() {
      zoom = parseFloat(zoomRange.value);
      draw();
    }

    function cleanup() {
      canvas.removeEventListener('mousedown', pointerDown);
      window.removeEventListener('mousemove', pointerMove);
      window.removeEventListener('mouseup', pointerUp);
      canvas.removeEventListener('touchstart', pointerDown);
      window.removeEventListener('touchmove', pointerMove);
      window.removeEventListener('touchend', pointerUp);
      zoomRange.removeEventListener('input', onZoom);
      btnConfirm.removeEventListener('click', onConfirm);
      btnCancel.removeEventListener('click', onCancel);
      overlay.removeEventListener('mousedown', onBackdrop);
      overlay.style.display = 'none';
    }

    function onConfirm() {
      // Recorta na resolução final mantendo o mesmo enquadramento
      const out = document.createElement('canvas');
      out.width = OUTPUT_SIZE;
      out.height = OUTPUT_SIZE;
      const octx = out.getContext('2d');
      const ratio = OUTPUT_SIZE / VIEW_SIZE;
      const scale = currentScale();
      const drawW = img.width * scale * ratio;
      const drawH = img.height * scale * ratio;
      const dx = (OUTPUT_SIZE - drawW) / 2 + offsetX * ratio;
      const dy = (OUTPUT_SIZE - drawH) / 2 + offsetY * ratio;
      octx.drawImage(img, dx, dy, drawW, drawH);
      const dataUrl = out.toDataURL('image/jpeg', 0.82);
      cleanup();
      resolve(dataUrl);
    }

    function onCancel() {
      cleanup();
      reject(new Error('cancelado'));
    }

    function onBackdrop(e) {
      if (e.target === overlay) onCancel();
    }

    canvas.addEventListener('mousedown', pointerDown);
    window.addEventListener('mousemove', pointerMove);
    window.addEventListener('mouseup', pointerUp);
    canvas.addEventListener('touchstart', pointerDown, { passive: true });
    window.addEventListener('touchmove', pointerMove, { passive: false });
    window.addEventListener('touchend', pointerUp);
    zoomRange.addEventListener('input', onZoom);
    btnConfirm.addEventListener('click', onConfirm);
    btnCancel.addEventListener('click', onCancel);
    overlay.addEventListener('mousedown', onBackdrop);

    overlay.style.display = 'flex';
    draw();
  }

  window.openAvatarCropper = openAvatarCropper;
})();
