import type { Issue, IssueData, IssueStatus } from './issues.ts';

const STATUS: Record<IssueStatus, { icon: string; label: string }> = {
  proposed: { icon: '📋', label: 'Proposed' },
  'in-progress': { icon: '🚧', label: 'In Progress' },
  done: { icon: '✅', label: 'Done' },
  blocked: { icon: '❌', label: 'Blocked' },
  icebox: { icon: '🕒', label: 'Icebox' },
};

export function renderIssueLog(data: IssueData): string {
  const open = data.issues.filter((issue) => !issue.closed);
  const closed = data.issues.filter((issue) => issue.closed);
  return [
    '# Issue Log',
    '',
    `_Last updated: ${formatDate(data.lastUpdated)}_`,
    '',
    '## Purpose',
    '',
    'Temporary compatibility view for legacy `ISS-nnn` records migrated into the Git-native Work Registry. New work uses one-file Work Items; this view remains deterministic during the reviewed migration window.',
    '',
    '## How to Use',
    '',
    '1. Use `pnpm workflow work-item list` or `inventory` for the current backlog.',
    '2. Resolve an `ISS-nnn` through its Work Item alias before changing canonical state.',
    '3. Use `pnpm workflow work-item review` for reviewed intake and priority changes.',
    '4. Use `pnpm workflow work-item render` to refresh backlog, inventory, history, and handoff projections.',
    '5. Use `pnpm workflow work-item validate` to prove records, links, and activated projections are current.',
    '6. Keep `workflow issue ...` only as a temporary compatibility surface; do not create a second long-term issue store.',
    '',
    '## Status Legend',
    '',
    ...Object.values(STATUS).map(({ icon, label }) => `- \`${icon} ${label}\``),
    '',
    '## Priority Buckets',
    '',
    '- `Now`: Should be worked immediately',
    '- `Next`: On deck once current tasks finish',
    '- `Later`: Nice-to-have or future phase',
    '',
    ...renderCategory('Feature Proposals', 'feature', open),
    '',
    ...renderCategory('Bugs & Regressions', 'bug', open),
    '',
    ...renderCategory('Enhancements & Tech Debt', 'enhancement', open),
    '',
    '## Archive',
    '',
    ...(closed.length === 0
      ? [
          '(Closed legacy records appear here during the migration window.)',
          '',
          table(['ID', 'Title', 'Requirement', 'Completion Notes', 'Date'], []),
        ]
      : [
          table(
            ['ID', 'Title', 'Requirement', 'Completion Notes', 'Date'],
            closed.map((issue) => [
              issue.id,
              issue.title,
              renderRequirement(issue),
              issue.closed?.notes ?? '',
              issue.closed?.date ?? '',
            ]),
          ),
        ]),
    '',
  ].join('\n');
}

function renderCategory(
  heading: string,
  category: Issue['category'],
  issues: Issue[],
): string[] {
  return [
    `## ${heading}`,
    '',
    table(
      [
        'ID',
        'Title',
        'Status',
        'Priority',
        'Requirement',
        'References',
        'Notes / Next Steps',
      ],
      issues
        .filter((issue) => issue.category === category)
        .map((issue) => [
          issue.id,
          issue.title,
          STATUS[issue.status].icon,
          issue.priority,
          renderRequirement(issue),
          issue.references.map((reference) => `\`${reference}\``).join(', '),
          issue.notes,
        ]),
    ),
  ];
}

function renderRequirement(issue: Issue): string {
  return issue.requirement
    ? `[${issue.requirement.label}](${issue.requirement.href})`
    : '—';
}

function table(headers: string[], rows: string[][]): string {
  return [
    `| ${headers.map(escapeCell).join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map(escapeCell).join(' | ')} |`),
  ].join('\n');
}

function escapeCell(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('\n', '<br>');
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'long',
    timeZone: 'UTC',
  }).format(new Date(`${value}T00:00:00Z`));
}
