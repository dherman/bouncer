export interface DocumentSummary {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  role: 'read' | 'comment' | 'edit';
  is_owner: boolean;
}
export async function getDocument(id: string): Promise<DocumentSummary> {
  const res = await authFetch(`${API_BASE}/api/docs/${encodeURIComponent(id)}`);
  if (!res.ok) {
    if (res.status === 403) ...{truncated}