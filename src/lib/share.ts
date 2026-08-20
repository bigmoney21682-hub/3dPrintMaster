/**
 * Getting a finished file off the phone.
 *
 * On a phone the useful path is the system share sheet: it is what puts a file
 * into Messages, Mail, AirDrop, Drive or the printer's own app, and it is the
 * only one of those a web page can reach. `mailto:` cannot carry an attachment,
 * so "email it" also means the share sheet. Desktop browsers mostly do not
 * implement file sharing, so everything falls back to a download.
 */

import { downloadBlob } from './stl';

export interface ShareFile {
  blob: Blob;
  filename: string;
}

function toFiles(files: ShareFile[]): File[] {
  return files.map((f) => new File([f.blob], f.filename, { type: f.blob.type || 'application/octet-stream' }));
}

/** Whether this browser can hand these particular files to the share sheet. */
export function canShareFiles(files: ShareFile[]): boolean {
  if (typeof navigator === 'undefined' || !navigator.canShare || !navigator.share) return false;
  try {
    return navigator.canShare({ files: toFiles(files) });
  } catch {
    return false;
  }
}

export type ShareOutcome = 'shared' | 'downloaded' | 'cancelled';

/**
 * Offer the files through the share sheet, falling back to a plain download.
 * Returns what actually happened so the caller can say so.
 */
export async function shareFiles(files: ShareFile[], title: string, text?: string): Promise<ShareOutcome> {
  if (files.length === 0) return 'cancelled';
  if (canShareFiles(files)) {
    try {
      await navigator.share({ files: toFiles(files), title, text });
      return 'shared';
    } catch (err) {
      // Dismissing the sheet is a normal outcome, not a failure to report.
      if (err instanceof Error && err.name === 'AbortError') return 'cancelled';
      // Anything else (a format the sheet refused, a permissions quirk) should
      // still leave the user holding the file.
    }
  }
  for (const file of files) downloadBlob(file.blob, file.filename);
  return 'downloaded';
}
