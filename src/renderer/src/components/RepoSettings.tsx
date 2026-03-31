import { useState } from 'react';
import type { AgentType, PolicyTemplateSummary, Repository } from '../../../main/types';

interface Props {
  repo: Repository;
  policies: PolicyTemplateSummary[];
  onSave: (id: string, changes: Partial<Repository>) => void;
  onClose: () => void;
}

export function RepoSettings({ repo, policies, onSave, onClose }: Props) {
  const [name, setName] = useState(repo.name);
  const [githubRepo, setGithubRepo] = useState(repo.githubRepo ?? '');
  const [defaultPolicyId, setDefaultPolicyId] = useState(repo.defaultPolicyId);
  const [defaultAgentType, setDefaultAgentType] = useState<AgentType>(repo.defaultAgentType);

  function handleSave() {
    const changes: Partial<Repository> = {};
    if (name !== repo.name) changes.name = name;
    if ((githubRepo || null) !== repo.githubRepo) changes.githubRepo = githubRepo || null;
    if (defaultPolicyId !== repo.defaultPolicyId) changes.defaultPolicyId = defaultPolicyId;
    if (defaultAgentType !== repo.defaultAgentType) changes.defaultAgentType = defaultAgentType;
    if (Object.keys(changes).length > 0) {
      onSave(repo.id, changes);
    }
    onClose();
  }

  return (
    <div className="repo-settings-overlay" onClick={onClose}>
      <div className="repo-settings" onClick={(e) => e.stopPropagation()}>
        <div className="repo-settings-header">
          <span>Repository Settings</span>
          <button type="button" className="close-btn" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="repo-settings-body">
          <label className="repo-settings-field">
            <span className="repo-settings-label">Name</span>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="repo-settings-field">
            <span className="repo-settings-label">Local path</span>
            <input type="text" value={repo.localPath} disabled />
          </label>
          <label className="repo-settings-field">
            <span className="repo-settings-label">GitHub repo</span>
            <input
              type="text"
              value={githubRepo}
              onChange={(e) => setGithubRepo(e.target.value)}
              placeholder="owner/repo"
            />
          </label>
          <label className="repo-settings-field">
            <span className="repo-settings-label">Default policy</span>
            <select value={defaultPolicyId} onChange={(e) => setDefaultPolicyId(e.target.value)}>
              {policies.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label className="repo-settings-field">
            <span className="repo-settings-label">Agent type</span>
            <select
              value={defaultAgentType}
              onChange={(e) => setDefaultAgentType(e.target.value as AgentType)}
            >
              <option value="claude-code">Claude Code</option>
              <option value="echo">Echo (test)</option>
            </select>
          </label>
        </div>
        <div className="repo-settings-footer">
          <button type="button" className="repo-settings-cancel" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="repo-settings-save" onClick={handleSave}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
