import { findBinary } from './path-search.js'
import { log } from './logger.js'
import { orchestrator } from './orchestrator.js'
import type { CitekeyRecord } from './key-manager.js'

// export singleton: https://k94n.com/es6-modules-single-instance-pattern
export const TeXstudio = new class {
  public enabled: boolean
  public texstudio: string

  constructor() {
    orchestrator.add({
      id: 'TeXstudio',
      description: 'TeXstudio support',
      needs: ['start'],
      startup: async () => {
        this.texstudio = await findBinary('texstudio', {
          mac: ['/Applications/texstudio.app/Contents/MacOS'],
          win: [ 'C:\\Program Files (x86)\\texstudio', 'C:\\Program Files\\texstudio' ],
        })
        this.enabled = !!this.texstudio
      },
    })
  }

  public async push(citation?: string) {
    if (!this.enabled) throw new Error('texstudio was not found')

    if (!citation) {
      try {
        const pane = Zotero.getActiveZoteroPane() // can Zotero 5 have more than one pane at all?
        const items = pane.getSelectedItems()
        citation = items.map(item => (Zotero.BetterBibTeX.KeyManager.get(item.id) as CitekeyRecord).citationKey).filter(citekey => citekey).join(',')
      }
      catch (err) { // zoteroPane.getSelectedItems() doesn't test whether there's a selection and errors out if not
        log.error('TeXstudio: Could not get selected items:', err)
        return
      }
    }

    if (!citation) return

    try {
      await Zotero.Utilities.Internal.exec(this.texstudio, [ '--insert-cite', citation ])
    }
    catch (err) {
      log.error('TeXstudio: Could not get execute texstudio:', err)
    }
  }
}
