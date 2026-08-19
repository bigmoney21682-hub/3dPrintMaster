import { useEffect, useRef } from 'react';
import { PATH_COLOURS, PATH_KINDS, type PreviewData } from '../lib/slicer';
import type { MachineProfile } from '../lib/slicer/machines';

/**
 * Top-down view of one sliced layer, drawn straight from the packed tool-path
 * arrays. Seeing the actual paths is the quickest way to tell whether a slice
 * is sane before sending it to a printer.
 */
export function LayerPreview({
  preview,
  layerIndex,
  machine,
  showBelow = true,
}: {
  preview: PreviewData;
  layerIndex: number;
  machine: MachineProfile;
  showBelow?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const parent = canvas.parentElement!;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cssWidth = parent.clientWidth;
    const cssHeight = Math.round((cssWidth * machine.bed.y) / machine.bed.x);
    canvas.width = Math.round(cssWidth * dpr);
    canvas.height = Math.round(cssHeight * dpr);
    canvas.style.height = `${cssHeight}px`;

    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssWidth, cssHeight);

    const bedMinX = machine.origin === 'center' ? -machine.bed.x / 2 : 0;
    const bedMinY = machine.origin === 'center' ? -machine.bed.y / 2 : 0;
    const scale = cssWidth / machine.bed.x;
    // Bed Y grows away from the operator, so flip it to match how the plate
    // looks from the front.
    const tx = (x: number) => (x - bedMinX) * scale;
    const ty = (y: number) => cssHeight - (y - bedMinY) * scale;

    ctx.fillStyle = '#0a0e1c';
    ctx.fillRect(0, 0, cssWidth, cssHeight);

    ctx.strokeStyle = '#1d2745';
    ctx.lineWidth = 1;
    const step = machine.bed.x > 200 ? 50 : 25;
    for (let x = 0; x <= machine.bed.x; x += step) {
      ctx.beginPath();
      ctx.moveTo(tx(bedMinX + x), 0);
      ctx.lineTo(tx(bedMinX + x), cssHeight);
      ctx.stroke();
    }
    for (let y = 0; y <= machine.bed.y; y += step) {
      ctx.beginPath();
      ctx.moveTo(0, ty(bedMinY + y));
      ctx.lineTo(cssWidth, ty(bedMinY + y));
      ctx.stroke();
    }
    ctx.strokeStyle = '#2c3b63';
    ctx.strokeRect(0.5, 0.5, cssWidth - 1, cssHeight - 1);

    const drawLayer = (index: number, alpha: number, forceColour?: string) => {
      if (index < 0 || index >= preview.printZ.length) return;
      ctx.globalAlpha = alpha;
      const from = preview.layerStart[index];
      const to = preview.layerStart[index + 1];
      let currentColour = '';
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      for (let p = from; p < to; p++) {
        const colour = forceColour ?? PATH_COLOURS[PATH_KINDS[preview.pathKind[p]]];
        if (colour !== currentColour) {
          currentColour = colour;
          ctx.strokeStyle = colour;
        }
        ctx.lineWidth = preview.pathKind[p] === 0 ? 1.6 : 1.1;
        const start = preview.pathStart[p];
        const end = preview.pathStart[p + 1];
        if (end - start < 2) continue;
        ctx.beginPath();
        ctx.moveTo(tx(preview.points[start * 2]), ty(preview.points[start * 2 + 1]));
        for (let v = start + 1; v < end; v++) {
          ctx.lineTo(tx(preview.points[v * 2]), ty(preview.points[v * 2 + 1]));
        }
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    };

    if (showBelow) drawLayer(layerIndex - 1, 0.22, '#5b6d94');
    drawLayer(layerIndex, 1);
  }, [preview, layerIndex, machine, showBelow]);

  return (
    <div className="layer-preview">
      <canvas ref={canvasRef} />
    </div>
  );
}

export function PathLegend() {
  const shown: Array<[string, string]> = [
    ['External wall', PATH_COLOURS['external-perimeter']],
    ['Inner wall', PATH_COLOURS.perimeter],
    ['Solid', PATH_COLOURS['solid-infill']],
    ['Infill', PATH_COLOURS.infill],
    ['Skirt / brim', PATH_COLOURS.skirt],
    ['Support', PATH_COLOURS.support],
  ];
  return (
    <div className="row wrap" style={{ gap: 10 }}>
      {shown.map(([label, colour]) => (
        <span key={label} className="faint" style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <i style={{ width: 12, height: 3, background: colour, borderRadius: 2, display: 'inline-block' }} />
          {label}
        </span>
      ))}
    </div>
  );
}
