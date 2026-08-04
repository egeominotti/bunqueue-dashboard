export function createdSummary(
  distinctIds: number,
  submitted: number
): { ok: boolean; msg: string } {
  return {
    ok: true,
    msg: `Accepted ${submitted} job submission${submitted === 1 ? '' : 's'}; server returned ${distinctIds} distinct job ID${distinctIds === 1 ? '' : 's'} (deduplication may reuse existing jobs)`,
  };
}

export function acceptedJobId(response: unknown): string {
  if (
    response == null ||
    typeof response !== 'object' ||
    (response as { ok?: unknown }).ok !== true ||
    typeof (response as { id?: unknown }).id !== 'string' ||
    !(response as { id: string }).id ||
    (response as { id: string }).id.length > 1024
  ) {
    throw new Error('Add job returned a malformed success response');
  }
  return (response as { id: string }).id;
}

export function acceptedBulkIds(response: unknown, submitted: number): string[] {
  const ids = (response as { ids?: unknown } | null)?.ids;
  if (
    response == null ||
    typeof response !== 'object' ||
    (response as { ok?: unknown }).ok !== true ||
    !Array.isArray(ids) ||
    ids.length !== submitted ||
    ids.some((id) => typeof id !== 'string' || id.length === 0 || id.length > 1024)
  ) {
    throw new Error('Bulk add returned a malformed success response');
  }
  return ids as string[];
}
