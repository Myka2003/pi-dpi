export interface ArchivePathInput {
  basePath: string;
  session: string;
  previousSession?: string;
  previousPath?: string;
  previousBlob?: string;
  remoteBlob?: string;
  branchPath: string;
}

export interface ArchivePathResult {
  path: string;
  branched: boolean;
}

/**
 * Select the archive path for one local session.
 * Once a session has forked, keep writing to that fork instead of creating
 * another timestamped copy on every timer tick.
 */
export function chooseArchivePath(input: ArchivePathInput): ArchivePathResult {
  if (
    input.previousSession === input.session &&
    input.previousPath &&
    input.previousPath !== input.basePath
  ) {
    return { path: input.previousPath, branched: true };
  }
  if (input.previousBlob && input.remoteBlob && input.previousBlob !== input.remoteBlob) {
    return { path: input.branchPath, branched: true };
  }
  return { path: input.basePath, branched: false };
}
