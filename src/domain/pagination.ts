export const PAGE_SIZE = 100;

// Filter and sort the complete set before paging so hidden rows remain discoverable.
export function paginate<T>(rows: readonly T[], pageInput: number) {
  const total = rows.length;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(Math.max(1, Math.trunc(pageInput) || 1), pageCount);
  return {
    rows: rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    total,
    page,
    pageCount,
    pageSize: PAGE_SIZE,
  };
}
