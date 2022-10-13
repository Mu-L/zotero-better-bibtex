declare const Zotero: any
declare const __estrace: any // eslint-disable-line no-underscore-dangle

import { affects, names as preferences, defaults, PreferenceName, Preferences as StoredPreferences, schema } from '../../gen/preferences/meta'
import { TeXMap } from '../../content/prefs'
import { client } from '../../content/client'
import { RegularItem, Item, Collection, Attachment } from '../../gen/typings/serialized-item'
import type { Exporter as BibTeXExporter } from '../bibtex/exporter'
import type { ZoteroItem } from '../bibtex/bibtex'

type Preferences = StoredPreferences & { texmap?: TeXMap }

type CacheableItem = Item & { $cacheable: boolean }
type CacheableRegularItem = RegularItem & { $cacheable: boolean }

const cacheDisabler = new class {
  get(target, property) {
    // if (typeof target.$unused === 'undefined') target.$unused = new Set(Object.keys(target).filter(field => !ignore_unused_fields.includes(field)))

    // collections: jabref 4 stores collection info inside the entry, and collection info depends on which part of your library you're exporting
    if (property === 'collections') {
      target.$cacheable = false
    }

    // use for the QR to highlight unused data
    // target.$unused.delete(property)

    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return target[property]
  }

  /*
  set(target, property, value): boolean {
    if (property === '$cacheable' && target.$cacheable && !value) log.debug('cache-rate: not for', target, (new Error).stack)
    target[property] = value
    return true
  }
  */
}

type NestedCollection = {
  key: string
  name: string
  items: CacheableItem[]
  collections: NestedCollection[]
  parent?: NestedCollection
}

export type TranslatorMetadata = {
  translatorID: string
  translatorType: number
  label: string
  description: string
  creator: string
  target: string
  minVersion: string
  maxVersion: string
  priority: number
  inRepository: boolean
  lastUpdated: string
  browserSupport: string

  displayOptions: {
    exportNotes: boolean
    exportFileData: boolean
    useJournalAbbreviation: boolean
    keepUpdated: boolean
    quickCopyMode: string
    Title: boolean
    Authors: boolean
    Year: boolean
    Normalize: boolean
    markdown: boolean
    cacheUse: boolean
  }

  configOptions: {
    getCollections: boolean
    async: boolean
  }
}

export class Items {
  private items: CacheableItem[] = []
  public map: Record<number | string, CacheableItem> = {}
  public current: CacheableItem

  constructor(items?: CacheableItem[]) {
    if (items) {
      this.items = items.map(item => this.map[item.itemID] = this.map[item.itemKey] = new Proxy(item, cacheDisabler) as CacheableItem)
    }
    else {
      let item: CacheableItem
      while (item = Zotero.nextItem()) {
        this.items.push(this.map[item.itemID] = this.map[item.itemKey] = new Proxy(item, cacheDisabler))
      }
    }

    // fallback to itemType.itemID for notes and attachments. And some items may have duplicate keys
    this.items.sort((a: any, b: any) => {
      const ka = [ a.citationKey || a.itemType, a.dateModified || a.dateAdded, a.itemID ].join('\t')
      const kb = [ b.citationKey || b.itemType, b.dateModified || b.dateAdded, b.itemID ].join('\t')
      return ka.localeCompare(kb, undefined, { sensitivity: 'base' })
    })
  }

  public cacheable(cacheable: boolean): void {
    for (const item of this.items) {
      item.$cacheable = cacheable
    }
  }

  *[Symbol.iterator](): Generator<CacheableItem, void, unknown> {
    for (const item of this.items) {
      yield item
    }
  }

  public get regular(): Generator<CacheableRegularItem, void, unknown> {
    return this._regular()
  }
  private *_regular(): Generator<CacheableRegularItem, void, unknown> {
    for (const item of this.items) {
      switch (item.itemType) {
        case 'annotation':
        case 'note':
        case 'attachment':
          break

        default:
          yield (this.current = item) as unknown as CacheableRegularItem
      }
    }
  }
}

export class Collections {
  public byKey: Record<string, Collection> = {}

  constructor(private items: Items, collections?: Record<string, Collection>) {
    if (collections) {
      this.byKey = collections
    }
    else if (Zotero.nextCollection) {
      let collection: any
      while (collection = Zotero.nextCollection()) {
        this.registerCollection(collection, '')
      }
    }
  }

  private registerCollection(collection, parent: string) {
    const key = (collection.primary ? collection.primary : collection).key
    if (this.byKey[key]) return // why does JM send collections twice?!

    this.byKey[key] = {
      key,
      parent,
      name: collection.name,
      collections: [],
      items: [],
    }

    for (const child of (collection.descendents || collection.children)) {
      switch (child.type) {
        case 'collection':
          this.byKey[key].collections.push(child.key as string)
          this.registerCollection(child, key)
          break
        case 'item':
          this.byKey[key].items.push(child.id as number)
          break
      }
    }
  }

  public get collectionTree(): NestedCollection[] {
    return Object.values(this.byKey).filter(coll => !coll.parent).map(coll => this.nestedCollection(coll))
  }

  private nestedCollection(collection: Collection): NestedCollection {
    const nested: NestedCollection = {
      key: collection.key,
      name: collection.name,
      items: collection.items.map((itemID: number) => this.items.map[itemID]).filter((item: Item) => item),
      collections: collection.collections.map((key: string) => this.nestedCollection(this.byKey[key])).filter((coll: NestedCollection) => coll),
    }

    for (const coll of nested.collections) {
      coll.parent = nested
    }
    return nested
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&')
}

export type Input = {
  items: Items
  collections: Collections
}

export type Output = {
  body: string
  attachments: Attachment[]
}

export function collect(): Input {
  const items = new Items
  return { items, collections: new Collections(items) }
}

export class Translation { // eslint-disable-line @typescript-eslint/naming-convention,no-underscore-dangle,id-blacklist,id-match
  public preferences: Preferences
  public importToExtra: Record<string, 'plain' | 'force'>
  public skipFields: string[]
  public skipField: Record<string, boolean>
  public verbatimFields?: (string | RegExp)[]
  public csquotes: { open: string, close: string }
  public export: { dir: string, path: string } = {
    dir: undefined,
    path: undefined,
  }

  public options: {
    quickCopyMode?: string
    dropAttachments?: boolean
    exportNotes?: boolean
    markdown?: boolean
    exportFileData?: boolean
    useJournalAbbreviation?: boolean
    keepUpdated?: boolean
    cacheUse?: boolean
    Title?: boolean
    Authors?: boolean
    Year?: boolean
    Normalize?: boolean
    worker?: boolean
  }

  public BetterBibLaTeX?: boolean                   // eslint-disable-line @typescript-eslint/naming-convention,no-underscore-dangle,id-blacklist,id-match
  public BetterBibTeX?: boolean                     // eslint-disable-line @typescript-eslint/naming-convention,no-underscore-dangle,id-blacklist,id-match
  public BetterTeX: boolean                         // eslint-disable-line @typescript-eslint/naming-convention,no-underscore-dangle,id-blacklist,id-match
  public BetterCSLJSON?: boolean                    // eslint-disable-line @typescript-eslint/naming-convention,no-underscore-dangle,id-blacklist,id-match
  public BetterCSLYAML?: boolean                    // eslint-disable-line @typescript-eslint/naming-convention,no-underscore-dangle,id-blacklist,id-match
  public BetterCSL?: boolean                        // eslint-disable-line @typescript-eslint/naming-convention,no-underscore-dangle,id-blacklist,id-match
  public BetterBibTeXCitationKeyQuickCopy?: boolean // eslint-disable-line @typescript-eslint/naming-convention,no-underscore-dangle,id-blacklist,id-match
  public BetterBibTeXJSON?: boolean                 // eslint-disable-line @typescript-eslint/naming-convention,no-underscore-dangle,id-blacklist,id-match
  public Citationgraph?: boolean                    // eslint-disable-line @typescript-eslint/naming-convention,no-underscore-dangle,id-blacklist,id-match
  public Collectednotes?: boolean                   // eslint-disable-line @typescript-eslint/naming-convention,no-underscore-dangle,id-blacklist,id-match
  // public TeX: boolean
  // public CSL: boolean

  public bibtex: BibTeXExporter
  public ZoteroItem: typeof ZoteroItem

  public input: {
    items: Items
    collections: Collections
  }
  public collections: Record<string, Collection> = {} // keep because it is being used in postscripts
  public output: Output = {
    body: '',
    attachments: [],
  }

  private cacheable = true

  public cache: {
    hits: number
    requests: number
  }

  public isJurisM: boolean
  public isZotero: boolean
  public unicode: boolean
  public platform: string
  public paths: {
    caseSensitive: boolean
    sep: string
  }

  public and: { list: { re: any, repl: string }, names: { re: any, repl: string } }

  public get exportDir(): string {
    this.input.items.current.$cacheable = false
    return this.export.dir
  }

  public get exportPath(): string {
    this.input.items.current.$cacheable = false
    return this.export.path
  }

  private typefield(field: string): string {
    field = field.trim()
    if (field.startsWith('bibtex.')) return this.BetterBibTeX ? field.replace(/^bibtex\./, '') : ''
    if (field.startsWith('biblatex.')) return this.BetterBibLaTeX ? field.replace(/^biblatex\./, '') : ''
    return field
  }

  static Import(translator: TranslatorMetadata): Translation {
    return new this(translator)
  }
  static Export(translator: TranslatorMetadata, input: Input): Translation {
    const translation = new this(translator)

    translation.input = input

    translation.cache = {
      hits: 0,
      requests: 0,
    }
    translation.export = {
      dir: (Zotero.getOption('exportDir') as string),
      path: (Zotero.getOption('exportPath') as string),
    }
    if (translation.export.dir?.endsWith(translation.paths.sep)) translation.export.dir = translation.export.dir.slice(0, -1)
    translation.options.cacheUse = Zotero.getOption('cacheUse')

    translation.unicode = !translation.preferences[`ascii${translator.label.replace(/Better /, '')}`] || false

    if (translation.preferences.baseAttachmentPath && (translation.export.dir === translation.preferences.baseAttachmentPath || translation.export.dir?.startsWith(translation.preferences.baseAttachmentPath + translation.paths.sep))) {
      translation.preferences.relativeFilePaths = true
    }

    // when exporting file data you get relative paths, when not, you get absolute paths, only one version can go into the cache
    // relative file paths are going to be different based on the file being exported to
    translation.cacheable = translation.cacheable && translation.preferences.cache && !(
      translation.options.exportFileData
      ||
      translation.preferences.relativeFilePaths
      ||
      (translation.preferences.baseAttachmentPath && translation.export.dir?.startsWith(translation.preferences.baseAttachmentPath))
    )

    if (translation.BetterTeX) {
      translation.preferences.separatorList = translation.preferences.separatorList.trim()
      translation.preferences.separatorNames = translation.preferences.separatorNames.trim()
      translation.and = {
        list: {
          re: new RegExp(escapeRegExp(translation.preferences.separatorList), 'g'),
          repl: ` {${translation.preferences.separatorList}} `,
        },
        names: {
          re: new RegExp(` ${escapeRegExp(translation.preferences.separatorNames)} `, 'g'),
          repl: ` {${translation.preferences.separatorNames}} `,
        },
      }
      translation.preferences.separatorList = ` ${translation.preferences.separatorList} `
      translation.preferences.separatorNames = ` ${translation.preferences.separatorNames} `
    }

    if (translation.preferences.testing && typeof __estrace === 'undefined' && schema.translator[translator.label]?.cache) {
      const ignored = {
        testing: true,
        texmap: true,
      }
      translation.preferences = new Proxy(translation.preferences, {
        set: (object, property, _value) => {
          throw new TypeError(`Unexpected set of preference ${String(property)}`)
        },
        get: (object, property: PreferenceName) => {
          // JSON.stringify will attempt to get this
          if (property as unknown as string === 'toJSON') return object[property]
          if (!ignored[property]) {
            if (!preferences.includes(property)) throw new TypeError(`Unsupported preference ${property}`)
            if (!affects[property]?.includes(translator.label)) throw new TypeError(`Preference ${property} claims not to affect ${translator.label}`)
          }
          return object[property] // eslint-disable-line @typescript-eslint/no-unsafe-return
        },
      })
    }

    translation.input.items.cacheable(translation.cacheable)
    translation.collections = translation.input.collections.byKey

    return translation
  }

  private constructor(public translator: TranslatorMetadata) {
    this[translator.label.replace(/[^a-z]/ig, '')] = true
    this.BetterTeX = this.BetterBibTeX || this.BetterBibLaTeX
    this.BetterCSL = this.BetterCSLJSON || this.BetterCSLYAML
    this.options = translator.displayOptions || {}

    this.platform = (Zotero.getHiddenPref('better-bibtex.platform') as string)
    this.isJurisM = client === 'jurism'
    this.isZotero = !this.isJurisM

    this.paths = {
      caseSensitive: this.platform !== 'mac' && this.platform !== 'win',
      sep: this.platform === 'win' ? '\\' : '/',
    }

    try {
      if (Zotero.getOption('cache') === false) this.cacheable = false
    }
    catch (err) {
    }

    for (const key in this.options) {
      if (typeof this.options[key] === 'boolean') {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        this.options[key] = Zotero.getOption(key)
      }
      else {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        this.options[key] = !!Zotero.getOption(key)
      }
    }

    this.preferences = Object.entries(defaults).reduce((acc, [pref, dflt]) => {
      acc[pref] = this.getPreferenceOverride(pref) ?? Zotero.getHiddenPref(`better-bibtex.${pref}`) ?? dflt
      return acc
    }, {} as unknown as Preferences)

    // special handling
    try {
      this.preferences.texmap = JSON.parse(this.preferences.charmap)
    }
    catch (err) {
      this.preferences.texmap = {}
    }

    this.importToExtra = {}
    this.preferences.importNoteToExtra
      .toLowerCase()
      .split(/\s*,\s*/)
      .filter(field => field)
      .forEach(field => {
        this.importToExtra[field.replace(/\s*=.*/, '')] = field.match(/\s*=\s*force$/) ? 'force' : 'plain'
      })
    this.skipFields = this.preferences.skipFields.toLowerCase().split(',').map(field => this.typefield(field)).filter((s: string) => s)
    this.skipField = this.skipFields.reduce((acc, field) => { acc[field] = true; return acc }, {})

    let m
    this.verbatimFields = this.preferences.verbatimFields
      .toLowerCase()
      .split(',')
      .map(field => (m = field.trim().match(/^[/](.+)[/]$/)) ? new RegExp(m[1], 'i') : this.typefield(field))
      .filter((s: string | RegExp) => s)

    if (!this.verbatimFields.length) this.verbatimFields = null
    this.csquotes = this.preferences.csquotes ? { open: this.preferences.csquotes[0], close: this.preferences.csquotes[1] } : null

    this.preferences.testing = (Zotero.getHiddenPref('better-bibtex.testing') as boolean)
  }

  saveAttachments(): void {
    if (!this.output?.attachments.length) return
    for (const attachment of this.output.attachments) {
      attachment.saveFile(attachment.defaultPath, true)
    }
  }

  getPreferenceOverride(pref) { // eslint-disable-line @typescript-eslint/explicit-module-boundary-types
    try {
      const override = Zotero.getOption(`preference_${pref}`)
      if (typeof override !== 'undefined') this.cacheable = false
      return override // eslint-disable-line @typescript-eslint/no-unsafe-return
    }
    catch (err) {
      return undefined
    }
  }
}
