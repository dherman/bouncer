import type { PolicyTemplate, PolicyTemplateSummary } from "./types.js";
import {
  standardPrTemplate,
  researchOnlyTemplate,
  permissiveTemplate,
} from "./policy-templates.js";

const BUILT_IN_TEMPLATES: PolicyTemplate[] = [
  standardPrTemplate,
  researchOnlyTemplate,
  permissiveTemplate,
];

export class PolicyTemplateRegistry {
  private templates: Map<string, PolicyTemplate>;

  constructor() {
    this.templates = new Map();
    for (const template of BUILT_IN_TEMPLATES) {
      if (this.templates.has(template.id)) {
        throw new Error(`Duplicate policy template id: ${template.id}`);
      }
      this.templates.set(template.id, template);
    }
  }

  get(id: string): PolicyTemplate {
    const template = this.templates.get(id);
    if (!template) throw new Error(`Unknown policy template: ${id}`);
    return template;
  }

  list(): PolicyTemplateSummary[] {
    return Array.from(this.templates.values()).map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
    }));
  }

  get defaultId(): string {
    return standardPrTemplate.id;
  }
}
