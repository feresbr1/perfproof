import { analyzeProfiles, type Analysis } from '../core/analyze';
import { ProfileError, toCpuProfile, type NamedProfile } from '../core/profile';

/** perfproof's own report.json (from the CLI) can be opened directly. */
function isAnalysis(data: unknown): data is Analysis {
  const a = data as Analysis;
  return Boolean(
    a && a.version === 1 && a.flame && Array.isArray(a.lines) && Array.isArray(a.functions),
  );
}

/**
 * Turn dropped files into a report. Several .cpuprofile files (one per process) are merged.
 * Everything happens in the browser; nothing is uploaded.
 */
export async function loadFiles(files: File[]): Promise<Analysis> {
  if (files.length === 0) throw new ProfileError('No file selected.');
  const profiles: NamedProfile[] = [];
  for (const file of files) {
    let data: unknown;
    try {
      data = JSON.parse(await file.text());
    } catch {
      throw new ProfileError(
        `${file.name} is not JSON, so it is not a .cpuprofile or perfproof report.`,
      );
    }
    if (isAnalysis(data)) {
      if (files.length > 1) throw new ProfileError('Open one perfproof report.json at a time.');
      return data;
    }
    try {
      profiles.push({ name: file.name.replace(/\.cpuprofile$/, ''), profile: toCpuProfile(data) });
    } catch (err) {
      throw new ProfileError(`${file.name}: ${(err as Error).message}`);
    }
  }
  return analyzeProfiles(profiles);
}
