import { useEffect, useState } from 'react';
import {
  createProject,
  deleteProject,
  listModels,
  listPhotos,
  listProjects,
  requestPersistence,
  saveProject,
  storageEstimate,
  type Project,
  type ProjectMode,
} from '../lib/db';
import { useNavigate } from '../lib/useHashRoute';
import { AppBar, formatBytes, relativeTime, useAsync, useNow, useObjectUrl, useToast } from './ui';
import { MINIMUM_FOR_3D } from '../lib/captureGuide';

interface ProjectSummary {
  project: Project;
  photoCount: number;
  modelCount: number;
  cover: Blob | null;
}

export function Library() {
  const navigate = useNavigate();
  const notify = useToast();
  const now = useNow();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [mode, setMode] = useState<ProjectMode>('scan');
  const [storage, setStorage] = useState<{ usage: number; quota: number } | null>(null);

  const { value: summaries, reload, loading } = useAsync<ProjectSummary[]>(async () => {
    const projects = await listProjects();
    return Promise.all(
      projects.map(async (project) => {
        const [photos, models] = await Promise.all([listPhotos(project.id), listModels(project.id)]);
        return {
          project,
          photoCount: photos.length,
          modelCount: models.length,
          cover: photos[0]?.thumb ?? null,
        };
      }),
    );
  }, []);

  useEffect(() => {
    storageEstimate().then(setStorage);
    requestPersistence();
  }, [summaries]);

  const create = async () => {
    const project = createProject(name, mode);
    await saveProject(project);
    setCreating(false);
    setName('');
    navigate(`p/${project.id}`);
  };

  const remove = async (project: Project) => {
    if (!confirm(`Delete "${project.name}" and everything in it? This cannot be undone.`)) return;
    await deleteProject(project.id);
    notify('Project deleted');
    reload();
  };

  return (
    <>
      <AppBar
        title="3dPrintMaster"
        subtitle="photo to printable STL"
        actions={
          <button className="btn ghost icon" onClick={() => navigate('guide')} aria-label="How to shoot">
            ?
          </button>
        }
      />
      <main className="stack">
        {creating ? (
          <div className="card stack">
            <h2>New project</h2>
            <div>
              <label className="field" htmlFor="proj-name">
                Name
              </label>
              <input
                id="proj-name"
                type="text"
                value={name}
                placeholder="e.g. Garden gnome"
                onChange={(e) => setName(e.target.value)}
                autoFocus
              />
            </div>
            <div className="stack" style={{ gap: 8 }}>
              <label className="field">What are you making?</label>
              <ModeCard
                active={mode === 'scan'}
                onClick={() => setMode('scan')}
                title="Scan an object"
                body={`Photograph it from all sides and carve a solid 3D model. Needs at least ${MINIMUM_FOR_3D} photos.`}
              />
              <ModeCard
                active={mode === 'relief'}
                onClick={() => setMode('relief')}
                title="Relief from one photo"
                body="Turn a single picture into a raised relief, a lithophane or a flat cut-out. One photo is enough."
              />
            </div>
            <div className="row">
              <button className="btn ghost" onClick={() => setCreating(false)}>
                Cancel
              </button>
              <span className="spacer" />
              <button className="btn primary" onClick={create}>
                Create
              </button>
            </div>
          </div>
        ) : (
          <button className="btn primary block" onClick={() => setCreating(true)}>
            + New project
          </button>
        )}

        {loading && !summaries && <div className="muted">Loading library…</div>}

        {summaries?.length === 0 && !creating && (
          <div className="empty-state">
            <div className="big">📷</div>
            <p>
              Nothing here yet. Create a project, photograph an object from every side, and this app carves an STL you
              can drop straight into FlashPrint.
            </p>
            <button className="btn" onClick={() => navigate('guide')}>
              How many photos do I need?
            </button>
          </div>
        )}

        {summaries && summaries.length > 0 && (
          <div className="stack" style={{ gap: 8 }}>
            {summaries.map((s) => (
              <ProjectRow key={s.project.id} summary={s} now={now} onOpen={() => navigate(`p/${s.project.id}`)} onDelete={() => remove(s.project)} />
            ))}
          </div>
        )}

        {storage && storage.quota > 0 && (
          <div className="faint">
            Library stored on this device: {formatBytes(storage.usage)} used of about {formatBytes(storage.quota)}{' '}
            available. Nothing is uploaded anywhere.
          </div>
        )}
      </main>
    </>
  );
}

function ModeCard({
  active,
  onClick,
  title,
  body,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  body: string;
}) {
  return (
    <button
      className="project-row"
      onClick={onClick}
      style={{ borderColor: active ? 'var(--accent)' : undefined, alignItems: 'flex-start' }}
    >
      <div style={{ flex: 1 }}>
        <strong>{title}</strong>
        <div className="faint">{body}</div>
      </div>
      <span aria-hidden style={{ color: active ? 'var(--accent)' : 'var(--text-faint)' }}>{active ? '●' : '○'}</span>
    </button>
  );
}

function ProjectRow({
  summary,
  now,
  onOpen,
  onDelete,
}: {
  summary: ProjectSummary;
  now: number;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const url = useObjectUrl(summary.cover);
  const { project, photoCount, modelCount } = summary;
  return (
    <div className="project-row">
      {url ? (
        <img className="thumb" src={url} alt="" />
      ) : (
        <div className="thumb empty" aria-hidden>
          {project.mode === 'relief' ? '▦' : '⬡'}
        </div>
      )}
      <button
        onClick={onOpen}
        style={{ flex: 1, background: 'none', border: 'none', textAlign: 'left', padding: 0, minWidth: 0 }}
      >
        <strong style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {project.name}
        </strong>
        <span className="faint">
          {project.mode === 'relief' ? 'Relief' : 'Scan'} · {photoCount} photo{photoCount === 1 ? '' : 's'} ·{' '}
          {modelCount} model{modelCount === 1 ? '' : 's'} · {relativeTime(project.updatedAt, now)}
        </span>
      </button>
      <button className="btn ghost icon danger" onClick={onDelete} aria-label={`Delete ${project.name}`}>
        ✕
      </button>
    </div>
  );
}
