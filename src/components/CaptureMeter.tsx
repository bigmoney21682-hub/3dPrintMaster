import { assessCapture, CAPTURE_TIERS, MINIMUM_FOR_3D, RECOMMENDED } from '../lib/captureGuide';

/**
 * The "how many photos do I need" readout. Deliberately prominent: it is the
 * single thing that most determines whether the resulting STL is worth printing.
 */
export function CaptureMeter({ photoCount, compact = false }: { photoCount: number; compact?: boolean }) {
  const a = assessCapture(photoCount);
  const maxPhotos = CAPTURE_TIERS[CAPTURE_TIERS.length - 1].photos;
  const ticks = [MINIMUM_FOR_3D, RECOMMENDED, 24, maxPhotos];

  const state = photoCount >= RECOMMENDED ? 'good' : photoCount >= MINIMUM_FOR_3D ? 'warn' : 'bad';

  return (
    <div className="card tight stack" style={{ gap: 9 }}>
      <div className="row">
        <strong style={{ fontSize: '0.92rem' }}>{a.headline}</strong>
        <span className="spacer" />
        <span className={`chip ${state}`}>{a.tier.label}</span>
      </div>

      <div>
        <div className="meter">
          <i style={{ width: `${Math.round(a.quality * 100)}%` }} />
        </div>
        <div className="meter-ticks" aria-hidden="true">
          {ticks.map((t) => (
            <span key={t} style={{ left: `${Math.min(100, (t / maxPhotos) * 100)}%` }}>
              {t}
            </span>
          ))}
        </div>
      </div>

      {!compact && <div className="faint">{a.advice}</div>}

      {photoCount > 0 && photoCount < MINIMUM_FOR_3D && (
        <div className="callout warn">
          <strong>{MINIMUM_FOR_3D} photos</strong> is the minimum for a printable 3D shape — one every 45° all the way
          around. Below that you can still make a relief or a flat cut-out from a single photo.
        </div>
      )}
    </div>
  );
}

export function TierTable({ photoCount }: { photoCount?: number }) {
  const active = photoCount == null ? null : assessCapture(photoCount).tier;
  return (
    <table className="tiers">
      <thead>
        <tr>
          <th>Photos</th>
          <th>Every</th>
          <th>Result</th>
        </tr>
      </thead>
      <tbody>
        {CAPTURE_TIERS.map((t) => (
          <tr key={t.photos} className={active === t ? 'highlight' : undefined}>
            <td className="n">{t.photos}</td>
            <td className="n">{t.spacingDeg ? `${t.spacingDeg}°` : '—'}</td>
            <td>
              <strong>{t.label}</strong>
              <div className="faint">{t.detail}</div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
