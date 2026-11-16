/** Exact immutable-tree identity observed while loading a Manifest; no repository operations. */
export type ImmutableGitTreeInvestigationObservation = Readonly<{
  kind: 'immutable-git-tree';
  commit: string;
  tree: string;
  path: string;
  blob: string;
  contentDigest: string;
}>;
