Components.utils.import("resource://gre/modules/AddonManager.jsm");
import { Translators } from "../translators";
import { getItemsAsync } from "../get-items-async";
import { Preference } from "../../gen/preferences";
import { log } from "../logger";
import { fromEntries } from "../object";
import * as unicode_table from "unicode2latex/tables/unicode.json";
const unicode2latex = fromEntries(Object.entries(unicode_table).map(([unicode, latex]) => [unicode, { text: latex.text || latex.math, math: !latex.text }]));
function tolatex(s) {
  if (!s)
    return "";
  return s.split("").map((c) => ({ ...unicode2latex[c] || { text: c, math: false } })).reduce((acc, c) => {
    const last = acc[acc.length - 1];
    if (last && last.math === c.math) {
      last.text += c.text;
    } else {
      acc.push(c);
    }
    return acc;
  }, []).map((c) => c.math ? `$${c.text}$` : c.text).join("");
}
function shortLabel(label, options) {
  if (typeof options[label] === "string")
    return options[label];
  return {
    article: "art.",
    chapter: "ch.",
    subchapter: "subch.",
    column: "col.",
    figure: "fig.",
    line: "l.",
    note: "n.",
    issue: "no.",
    opus: "op.",
    page: "p.",
    paragraph: "para.",
    subparagraph: "subpara.",
    part: "pt.",
    rule: "r.",
    section: "sec.",
    subsection: "subsec.",
    Section: "Sec.",
    "sub verbo": "sv.",
    schedule: "sch.",
    title: "tit.",
    verse: "vrs.",
    volume: "vol."
  }[label] || label;
}
function citation2latex(citation, options) {
  let formatted = "";
  const label = `${shortLabel(citation.label, { page: "", ...options })} `.trimLeft();
  if (citation.prefix)
    formatted += `[${tolatex(citation.prefix)}]`;
  if (citation.locator && citation.suffix) {
    formatted += `[${tolatex(label)}${tolatex(citation.locator)}, ${tolatex(citation.suffix)}]`;
  } else if (citation.locator) {
    formatted += `[${tolatex(label)}${tolatex(citation.locator)}]`;
  } else if (citation.suffix) {
    formatted += `[${tolatex(citation.suffix)}]`;
  } else if (citation.prefix) {
    formatted += "[]";
  }
  formatted += `{${citation.citekey}}`;
  return formatted;
}
export const Formatter = new class {
  async playground(citations, options) {
    const formatted = await citations.map((cit) => `${options.keyprefix || ""}${cit.citekey}${options.keypostfix || ""}`);
    return formatted.length ? `${options.citeprefix || ""}${formatted.join(options.separator || ",")}${options.citekeypostfix || ""}` : "";
  }
  async citationLinks(citations, _options) {
    return await citations.map((citation) => `cites: ${citation.citekey}`).join("\n");
  }
  async cite(citations, options) {
    return this.natbib(citations, options);
  }
  async citet(citations, options) {
    return this.natbib(citations, { command: "citet", ...options });
  }
  async citep(citations, options) {
    return this.natbib(citations, { command: "citep", ...options });
  }
  async latex(citations, options) {
    return this.natbib(citations, options);
  }
  async natbib(citations, options) {
    if (!options.command)
      options.command = "cite";
    if (citations.length === 0)
      return "";
    if (citations.length > 1) {
      const state = citations.reduce((acc, cit) => {
        for (const field of ["prefix", "suffix", "suppressAuthor", "locator", "label"]) {
          acc[field] = (acc[field] || 0) + (cit[field] ? 1 : 0);
        }
        return acc;
      }, {});
      if (state.suffix === 0 && state.prefix === 0 && state.locator === 0 && (state.suppressAuthor === 0 || state.suppressAuthor === citations.length)) {
        return `\\${citations[0].suppressAuthor ? "citeyear" : options.command}{${citations.map((citation) => citation.citekey).join(",")}}`;
      }
    }
    let formatted = "";
    for (const citation of citations) {
      formatted += `\\${citation.suppressAuthor ? "citeyear" : options.command}${citation2latex(citation, options)}`;
    }
    return formatted;
  }
  async biblatex(citations, options) {
    if (citations.length === 0)
      return "";
    let command = options.command ? options.command : "autocite";
    if (citations.length === 1) {
      const citation = citations[0];
      const suppressAuthor = citation.suppressAuthor && /^(auto|paren|)cite$/.exec(command) ? "*" : "";
      return `\\${command}${suppressAuthor}${citation2latex(citation, options)}`;
    }
    citations = citations.map(citation2latex).join("");
    if (citations.includes("[")) {
      command = command.endsWith("s") ? command : `${command}s`;
    } else {
      citations = citations.replace(/\}\{/g, ",");
    }
    return `\\${command}${citations}`;
  }
  async mmd(citations, _options) {
    const formatted = [];
    for (const citation of citations) {
      if (citation.prefix) {
        formatted.push(`[${citation.prefix}][#${citation.citekey}]`);
      } else {
        formatted.push(`[#${citation.citekey}][]`);
      }
    }
    return formatted.join("");
  }
  async pandoc(citations, options) {
    const formatted = [];
    for (const citation of citations) {
      let cite = "";
      if (citation.prefix)
        cite += `${citation.prefix} `;
      if (citation.suppressAuthor)
        cite += "-";
      cite += `@${citation.citekey}`;
      if (citation.locator)
        cite += `, ${shortLabel(citation.label, options)} ${citation.locator}`.replace(/\s+/, " ");
      if (citation.suffix)
        cite += ` ${citation.suffix}`;
      formatted.push(cite);
    }
    return `${options.brackets ? "[" : ""}${formatted.join("; ")}${options.brackets ? "]" : ""}`;
  }
  async "asciidoctor-bibtex"(citations, options) {
    const formatted = [];
    for (const citation of citations) {
      let cite = citation.citekey;
      if (citation.locator) {
        const label = `${shortLabel(citation.label, { page: "", ...options })} ${citation.locator}`.trim();
        cite += `(${label})`;
      }
      formatted.push(cite);
    }
    return `${options.cite || "cite"}:[${formatted.join(", ")}]`;
  }
  async "scannable-cite"(citations, options) {
    const odfScan = await new Promise((resolve, _reject) => {
      AddonManager.getAddonByID("rtf-odf-scan-for-zotero@mystery-lab.com", (addon) => resolve(addon && addon.isActive));
    });
    if (!odfScan)
      throw new Error('scannable-cite needs the "RTF/ODF Scan for Zotero" plugin to be installed');
    const items = await getItemsAsync(citations.map((picked) => picked.id));
    const labels = (await Translators.exportItems("248bebf1-46ab-4067-9f93-ec3d2960d0cd", null, { type: "items", items })).split(/[{}]+/).filter((cite) => cite).reduce((result, item) => {
      const [, text, , , id] = item.split("|").map((v) => v.trim());
      result[id] = text;
      return result;
    }, {});
    if (citations.length !== Object.keys(labels).length)
      throw new Error(`Scannable Cite parse error: picked ${citations.length}, found ${Object.keys(labels).length}`);
    let citation = "";
    for (const item of citations) {
      const [, kind, lib, key] = item.uri.match(/^http:\/\/zotero\.org\/(users|groups)\/((?:local\/)?[^/]+)\/items\/(.+)/);
      const id = `${kind === "users" ? "zu" : "zg"}:${lib.startsWith("local/") ? "0" : lib}:${key}`;
      if (!labels[id])
        throw new Error(`No formatted citation found for ${id}`);
      const enriched = [
        item.prefix || "",
        `${item.suppressAuthor ? "-" : ""}${labels[id]}`,
        item.locator ? `${shortLabel(item.label, options)} ${item.locator}`.trim() : "",
        item.suffix || "",
        Preference.testing ? "zu:0:ITEMKEY" : id
      ].join(" | ").replace(/ +/g, " ");
      citation += `{ ${enriched.trim()} }`;
    }
    return citation;
  }
  async "formatted-citation"(citations, options) {
    let quickCopy = Zotero.Prefs.get("export.quickCopy.setting");
    log.debug("CAYW.formatted-citation: format=", quickCopy, "options=", options);
    if (options.style) {
      quickCopy = `bibliography/${options.contentType || "text"}=`;
      if (!options.style.startsWith("http://"))
        quickCopy += "http://www.zotero.org/styles/";
      quickCopy += options.style;
    }
    const format = Zotero.QuickCopy.unserializeSetting(quickCopy);
    log.debug("CAYW.formatted-citation: format=", quickCopy, format);
    if (format.mode !== "bibliography") {
      throw new Error(`formatted-citations requires the Zotero default quick-copy format to be set to a citation style; it is currently ${format}`);
    }
    await getItemsAsync(citations.map((item) => item.id));
    const locale = format.locale ? format.locale : Zotero.Prefs.get("export.quickCopy.locale");
    const csl = Zotero.Styles.get(format.id).getCiteProc(locale);
    csl.updateItems(citations.map((item) => item.id));
    const citation = {
      citationItems: citations.map((item) => ({ ...item, "suppress-author": item.suppressAuthor })),
      properties: {}
    };
    return csl.previewCitationCluster(citation, [], [], format.contentType);
  }
  async "formatted-bibliography"(citations) {
    const format = Zotero.Prefs.get("export.quickCopy.setting");
    if (Zotero.QuickCopy.unserializeSetting(format).mode !== "bibliography") {
      throw new Error(`formatted-bibliography requires the Zotero default quick-copy format to be set to a citation style; it is currently ${format}`);
    }
    const items = await getItemsAsync(citations.map((item) => item.id));
    return Zotero.QuickCopy.getContentFromItems(items, format, null, false).text;
  }
  async translate(citations, options) {
    const items = await getItemsAsync(citations.map((citation) => citation.id));
    const label = (options.translator || "biblatex").replace(/\s/g, "").toLowerCase().replace("better", "");
    const translator = Object.keys(Translators.byId).find((id) => Translators.byId[id].label.replace(/\s/g, "").toLowerCase().replace("better", "") === label) || options.translator;
    const exportOptions = {
      exportNotes: ["yes", "y", "true"].includes((options.exportNotes || "").toLowerCase()),
      useJournalAbbreviation: ["yes", "y", "true"].includes((options.useJournalAbbreviation || "").toLowerCase())
    };
    return await Translators.exportItems(translator, exportOptions, { type: "items", items });
  }
  async json(citations, _options) {
    return JSON.stringify(citations);
  }
}();