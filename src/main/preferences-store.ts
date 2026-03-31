import { join } from 'node:path'
import { homedir } from 'node:os'
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'

interface Preferences {
  focusedRepoId?: string
}

export class PreferencesStore {
  private prefs: Preferences = {}
  private configPath: string

  constructor(configDir?: string) {
    const dir = configDir ?? join(homedir(), '.config', 'bouncer')
    this.configPath = join(dir, 'preferences.json')
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.configPath, 'utf-8')
      this.prefs = JSON.parse(raw)
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.prefs = {}
      } else {
        throw err
      }
    }
  }

  private async save(): Promise<void> {
    const dir = join(this.configPath, '..')
    await mkdir(dir, { recursive: true })
    const json = JSON.stringify(this.prefs, null, 2) + '\n'
    const tmpPath = this.configPath + '.tmp'
    await writeFile(tmpPath, json, 'utf-8')
    await rename(tmpPath, this.configPath)
  }

  get focusedRepoId(): string | undefined {
    return this.prefs.focusedRepoId
  }

  async setFocusedRepoId(id: string): Promise<void> {
    this.prefs.focusedRepoId = id
    await this.save()
  }
}
