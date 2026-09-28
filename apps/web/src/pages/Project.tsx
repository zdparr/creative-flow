import { useCallback, useEffect, useState } from 'react';
import { api, errorText } from '../api.js';
import { ErrorNote, STATUS_LABELS } from '../components.js';
import { navigate } from '../router.js';
import type { Project, ProjectStatus } from '../types.js';
import { BibleScreen } from './Bible.js';
import { ChaptersScreen } from './Chapters.js';
import { InterviewScreen } from './Interview.js';
import { OutlineScreen } from './Outline.js';

type Tab = 'interview' | 'bible' | 'outline' | 'chapters';

const ORDER: ProjectStatus[] = [
  'intake',
  'bible_review',
  'outline_review',
  'writing',
  'assembling',
  'complete',
];
const reached = (status: ProjectStatus, target: ProjectStatus) =>
  ORDER.indexOf(status) >= ORDER.indexOf(target);

/** The screen the author should see by default for each stage. */
function defaultTab(status: ProjectStatus): Tab {
  if (status === 'intake') return 'interview';
  if (status === 'bible_review') return 'bible';
  if (status === 'outline_review') return 'outline';
  return 'chapters';
}

export function ProjectPage({ id, tab }: { id: string; tab?: string }) {
  const [project, setProject] = useState<Project | null>(null);
  const [error, setError] = useState<ReturnType<typeof errorText> | null>(null);

  const reload = useCallback(async () => {
    try {
      setProject(await api<Project>('GET', `/projects/${id}`));
    } catch (err) {
      setError(errorText(err));
    }
  }, [id]);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (error)
    return (
      <main className="shell">
        <ErrorNote error={error} />
      </main>
    );
  if (!project) return null;

  const active: Tab =
    tab === 'interview' || tab === 'bible' || tab === 'outline' || tab === 'chapters'
      ? tab
      : defaultTab(project.status);
  const tabs: { key: Tab; label: string; enabled: boolean }[] = [
    { key: 'interview', label: 'Interview', enabled: true },
    { key: 'bible', label: 'Bible', enabled: reached(project.status, 'bible_review') },
    { key: 'outline', label: 'Outline', enabled: reached(project.status, 'outline_review') },
    { key: 'chapters', label: 'Chapters', enabled: reached(project.status, 'writing') },
  ];

  return (
    <main className="shell wide">
      <div className="project-head">
        <div>
          <h1>{project.title}</h1>
          <span className="badge">{STATUS_LABELS[project.status]}</span>
        </div>
        <nav className="tabs" aria-label="Project sections">
          {tabs.map((t) => (
            <button
              key={t.key}
              className={t.key === active ? 'tab active' : 'tab'}
              disabled={!t.enabled}
              aria-current={t.key === active ? 'page' : undefined}
              onClick={() => navigate(`/projects/${id}/${t.key}`)}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </div>

      {active === 'interview' && <InterviewScreen project={project} onAdvance={reload} />}
      {active === 'bible' && <BibleScreen project={project} onChange={reload} />}
      {active === 'outline' && <OutlineScreen project={project} onChange={reload} />}
      {active === 'chapters' && <ChaptersScreen project={project} />}
    </main>
  );
}
