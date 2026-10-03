import { loadBitmap } from "./imageUtils.js";

const EDIT_SIZE = 280; // 편집 화면에 보여줄 정사각형 캔버스 크기(캔버스 픽셀)
const OUTPUT_SIZE = 512; // 최종 저장할 이미지 크기
// 확대/축소 범위 — zoom 1 = 틀을 꽉 채우는 크기(cover). 축소는 "사진 전체가 틀 안에 들어오는 크기(contain)"의
// 절반까지, 확대는 cover의 5배까지.
const MIN_ZOOM_OF_CONTAIN = 0.5;
const MAX_ZOOM = 5;
const WHEEL_STEP = 1.1; // 휠 한 칸에 이만큼 배율

/**
 * 초상화 틀(모서리 둥근 사각형 — 틀 모양은 CSS의 .crop-canvas-wrap)에 들어갈 사진의 위치(드래그)와
 * 확대/축소(슬라이더·마우스 휠·두 손가락 핀치)를 조정하는 모달 편집기.
 * open(source)에 File/Blob을 넘기면, 사용자가 "적용"을 누른 결과 Blob으로(취소하면 null로) resolve된다.
 *
 * - 확대/축소는 슬라이더면 틀 가운데, 휠·핀치면 커서·손가락 위치를 기준으로 한다(그 점이 제자리에 머문다).
 * - 슬라이더는 로그 눈금이라 축소 쪽과 확대 쪽이 같은 손놀림으로 움직인다.
 * - 틀보다 작게 줄이면 남는 자리는 투명(초상화 칸 배경색이 보임)이고, 사진은 틀 밖으로는 못 나간다.
 */
export class ImageCropEditor {
  constructor(modalEl) {
    this.modalEl = modalEl;
    this.canvas = modalEl.querySelector("#crop-canvas");
    this.ctx = this.canvas.getContext("2d");
    this.zoomInput = modalEl.querySelector("#crop-zoom");
    this.applyBtn = modalEl.querySelector('[data-action="crop-apply"]');
    this.cancelBtn = modalEl.querySelector('[data-action="crop-cancel"]');

    // 슬라이더는 0~1000 정수 눈금 → _sliderToZoom으로 로그 변환
    this.zoomInput.min = "0";
    this.zoomInput.max = "1000";
    this.zoomInput.step = "1";

    this.bitmap = null;
    this.baseScale = 1;
    this.minZoom = 1;
    this.zoom = 1;
    this.offsetX = 0;
    this.offsetY = 0;
    this._pointers = new Map(); // pointerId -> { x, y } (캔버스 픽셀)
    this._pinchDist = 0;
    this._resolve = null;

    this._wireEvents();
  }

  /** source: File 또는 Blob. 사용자가 취소하면 null, 적용하면 잘라낸 결과 Blob으로 resolve된다. */
  open(source) {
    return new Promise((resolve) => {
      this._resolve = resolve;
      loadBitmap(source).then((bitmap) => {
        this.bitmap = bitmap;
        this.baseScale = Math.max(EDIT_SIZE / bitmap.width, EDIT_SIZE / bitmap.height);
        const containZoom = Math.min(bitmap.width, bitmap.height) / Math.max(bitmap.width, bitmap.height);
        this.minZoom = containZoom * MIN_ZOOM_OF_CONTAIN;
        this.zoom = 1;
        this.offsetX = 0;
        this.offsetY = 0;
        this._pointers.clear();
        this._syncSlider();
        this.modalEl.classList.add("open");
        this._draw();
      });
    });
  }

  _wireEvents() {
    const c = this.canvas;
    c.addEventListener("pointerdown", (e) => {
      this._pointers.set(e.pointerId, this._canvasPoint(e));
      if (this._pointers.size === 2) this._pinchDist = this._pointerDistance();
      try { c.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    });
    c.addEventListener("pointermove", (e) => {
      const prev = this._pointers.get(e.pointerId);
      if (!prev || !this.bitmap) return;
      const cur = this._canvasPoint(e);
      if (this._pointers.size >= 2) {
        // 핀치: 두 손가락 사이 거리 비율만큼 확대/축소 + 가운데점이 움직인 만큼 이동
        const before = this._pointerMidpoint();
        this._pointers.set(e.pointerId, cur);
        const after = this._pointerMidpoint();
        const dist = this._pointerDistance();
        if (this._pinchDist > 0) this._zoomAt(this.zoom * (dist / this._pinchDist), after);
        this._pinchDist = dist;
        this.offsetX += after.x - before.x;
        this.offsetY += after.y - before.y;
      } else {
        this._pointers.set(e.pointerId, cur);
        this.offsetX += cur.x - prev.x;
        this.offsetY += cur.y - prev.y;
      }
      this._clampOffset();
      this._draw();
    });
    const endPointer = (e) => {
      this._pointers.delete(e.pointerId);
      this._pinchDist = this._pointers.size === 2 ? this._pointerDistance() : 0;
    };
    c.addEventListener("pointerup", endPointer);
    c.addEventListener("pointercancel", endPointer);

    c.addEventListener("wheel", (e) => {
      if (!this.bitmap) return;
      e.preventDefault();
      this._zoomAt(this.zoom * (e.deltaY < 0 ? WHEEL_STEP : 1 / WHEEL_STEP), this._canvasPoint(e));
      this._clampOffset();
      this._draw();
    }, { passive: false });

    this.zoomInput.addEventListener("input", () => {
      if (!this.bitmap) return;
      this._zoomAt(this._sliderToZoom(Number(this.zoomInput.value)), { x: EDIT_SIZE / 2, y: EDIT_SIZE / 2 }, { fromSlider: true });
      this._clampOffset();
      this._draw();
    });

    this.applyBtn.addEventListener("click", () => this._finish(true));
    this.cancelBtn.addEventListener("click", () => this._finish(false));
    this.modalEl.addEventListener("click", (e) => {
      if (e.target === this.modalEl) this._finish(false);
    });
  }

  /** 이벤트 위치 → 캔버스 픽셀 좌표(작은 화면에서 캔버스가 CSS로 줄어 있어도 맞게). */
  _canvasPoint(e) {
    const r = this.canvas.getBoundingClientRect();
    const k = EDIT_SIZE / (r.width || EDIT_SIZE);
    return { x: (e.clientX - r.left) * k, y: (e.clientY - r.top) * k };
  }

  _pointerDistance() {
    const [a, b] = [...this._pointers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  _pointerMidpoint() {
    const [a, b] = [...this._pointers.values()];
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }

  /** zoom을 바꾸되 캔버스 위의 점 p(캔버스 픽셀)에 있던 사진 지점이 그 자리에 머물게 오프셋을 맞춘다. */
  _zoomAt(zoom, p, { fromSlider = false } = {}) {
    const next = Math.min(MAX_ZOOM, Math.max(this.minZoom, zoom));
    const k = next / this.zoom;
    const ax = p.x - EDIT_SIZE / 2;
    const ay = p.y - EDIT_SIZE / 2;
    this.offsetX = ax + (this.offsetX - ax) * k;
    this.offsetY = ay + (this.offsetY - ay) * k;
    this.zoom = next;
    if (!fromSlider) this._syncSlider();
  }

  _sliderToZoom(v) {
    return this.minZoom * Math.pow(MAX_ZOOM / this.minZoom, v / 1000);
  }

  _syncSlider() {
    this.zoomInput.value = String(Math.round((1000 * Math.log(this.zoom / this.minZoom)) / Math.log(MAX_ZOOM / this.minZoom)));
  }

  /** 틀보다 크면 틀에 빈틈이 안 보이게, 틀보다 작으면 사진이 틀 밖으로 안 나가게 오프셋 범위를 제한한다. */
  _clampOffset() {
    const scale = this.baseScale * this.zoom;
    const maxX = Math.abs(this.bitmap.width * scale - EDIT_SIZE) / 2;
    const maxY = Math.abs(this.bitmap.height * scale - EDIT_SIZE) / 2;
    this.offsetX = Math.min(maxX, Math.max(-maxX, this.offsetX));
    this.offsetY = Math.min(maxY, Math.max(-maxY, this.offsetY));
  }

  _draw() {
    const scale = this.baseScale * this.zoom;
    const drawnW = this.bitmap.width * scale;
    const drawnH = this.bitmap.height * scale;
    const x = (EDIT_SIZE - drawnW) / 2 + this.offsetX;
    const y = (EDIT_SIZE - drawnH) / 2 + this.offsetY;
    this.ctx.clearRect(0, 0, EDIT_SIZE, EDIT_SIZE);
    this.ctx.drawImage(this.bitmap, x, y, drawnW, drawnH);
  }

  async _finish(applied) {
    this.modalEl.classList.remove("open");
    this._pointers.clear();
    if (!applied || !this.bitmap) {
      this.bitmap = null;
      const resolve = this._resolve;
      this._resolve = null;
      resolve?.(null);
      return;
    }

    // 편집 화면(EDIT_SIZE)에서 본 그대로를 OUTPUT_SIZE 해상도로 다시 그려서 최종 결과를 만든다.
    const ratio = OUTPUT_SIZE / EDIT_SIZE;
    const scale = this.baseScale * this.zoom * ratio;
    const drawnW = this.bitmap.width * scale;
    const drawnH = this.bitmap.height * scale;
    const x = (OUTPUT_SIZE - drawnW) / 2 + this.offsetX * ratio;
    const y = (OUTPUT_SIZE - drawnH) / 2 + this.offsetY * ratio;

    const outCanvas = document.createElement("canvas");
    outCanvas.width = OUTPUT_SIZE;
    outCanvas.height = OUTPUT_SIZE;
    const outCtx = outCanvas.getContext("2d");
    outCtx.imageSmoothingQuality = "high";
    outCtx.drawImage(this.bitmap, x, y, drawnW, drawnH);

    this.bitmap = null;
    const blob = await new Promise((resolve) => outCanvas.toBlob(resolve, "image/webp", 0.85));
    const resolve = this._resolve;
    this._resolve = null;
    resolve?.(blob);
  }
}
