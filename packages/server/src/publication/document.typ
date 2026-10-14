#let publication = json("publication.json")
#let ink = rgb("29251f")
#let muted = rgb("696054")
#let accent = rgb("796028")
#let labelled(body, name) = [#body#label(name)]
#let descendants(node, kind) = {
  let found = if node.type == kind { (node,) } else { () }
  found + node.at("children", default: ()).map(child => descendants(child, kind)).flatten()
}
#let definitions = descendants(publication.tree, "definition")
#let notes = descendants(publication.tree, "footnoteDefinition")
#let citations(node) = {
  if node.type == "footnoteDefinition" { return () }
  if node.type == "footnoteReference" { return (node.identifier,) }
  node.at("children", default: ()).map(citations).flatten()
}
#let cited = citations(publication.tree).dedup()
#let cursor = 0
#while cursor < cited.len() {
  let note = notes.find(note => note.identifier == cited.at(cursor))
  if note != none {
    for id in note.children.map(citations).flatten() {
      if not cited.contains(id) { cited.push(id) }
    }
  }
  cursor += 1
}
#let inline-link(url, body) = {
  if url.starts-with("#") and url.len() > 1 {
    link(label("heading-" + url.slice(1)), body)
  } else if url.starts-with("https:") or url.starts-with("http:") or url.starts-with("mailto:") {
    link(url, body)
  } else {
    body
  }
}
#let render(node, prefix: []) = {
  let children() = node.at("children", default: ()).map(render).join()
  if node.type == "root" { children() }
  else if node.type == "text" or node.type == "html" { text(node.value) }
  else if node.type == "paragraph" { par([#prefix#children()]) }
  else if node.type == "strong" { strong(children()) }
  else if node.type == "emphasis" { emph(children()) }
  else if node.type == "delete" { strike(children()) }
  else if node.type == "break" { linebreak() }
  else if node.type == "thematicBreak" { block(width: 100%, line(length: 30%, stroke: 0.4pt + muted)) }
  else if node.type == "inlineCode" { raw(node.value) }
  else if node.type == "code" { raw(node.value, block: true, lang: node.at("lang", default: none)) }
  else if node.type == "heading" { labelled(heading(level: node.depth, children()), "heading-" + node.data.hProperties.id) }
  else if node.type == "blockquote" { block(inset: (left: 12pt), stroke: (left: 1pt + accent), children()) }
  else if node.type == "list" {
    let items = node.children.map(render)
    if node.ordered { enum(start: node.at("start", default: 1), ..items) }
    else { list(..items) }
  }
  else if node.type == "listItem" {
    let checked = node.at("checked", default: none)
    if checked != none and node.children.len() > 0 {
      render(node.children.first(), prefix: text(if checked { "[x] " } else { "[ ] " }))
      node.children.slice(1).map(render).join()
    } else { children() }
  }
  else if node.type == "link" { inline-link(node.url, children()) }
  else if node.type == "image" { inline-link(node.url, text("Image: " + node.at("alt", default: ""))) }
  else if node.type == "linkReference" or node.type == "imageReference" {
    let definition = definitions.find(item => item.identifier == node.identifier)
    let body = if node.type == "imageReference" { text("Image: " + node.at("alt", default: "")) } else { children() }
    if definition == none { body } else { inline-link(definition.url, body) }
  }
  else if node.type == "footnoteReference" {
    let number = cited.position(id => id == node.identifier) + 1
    super(link(label("note-" + node.identifier), str(number)))
  }
  else if node.type == "footnoteDefinition" or node.type == "definition" { [] }
  else if node.type == "table" {
    let alignments = node.align.map(value => if value == "center" { center } else if value == "right" { right } else { left })
    set text(size: 9pt)
    table(
      columns: (1fr,) * node.align.len(),
      align: (column, row) => alignments.at(column),
      inset: 5pt,
      stroke: (top: none, left: none, right: none, bottom: 0.35pt + rgb("d6cfc3")),
      table.header(..node.children.first().children.map(cell => strong(render(cell)))),
      ..node.children.slice(1).map(row => row.children.map(render)).flatten(),
    )
  }
  else if node.type == "tableCell" { children() }
  else { panic("Unsupported Markdown node") }
}

#set document(title: publication.title, author: "Great Minds")
#set page(
  paper: publication.paper,
  margin: (x: 21mm, top: 22mm, bottom: 23mm),
  footer: context align(right, text(font: "JetBrains Mono", size: 8pt, fill: muted, counter(page).display("1 / 1", both: true))),
)
#set text(font: ("Libre Baskerville", "DejaVu Serif", "DejaVu Sans", "Noto Sans SC"), size: 10.5pt, fill: ink, lang: "en", hyphenate: false)
#set par(leading: 0.65em, spacing: 0.9em)
#set heading(numbering: none)
#show heading: set block(above: 1.5em, below: 0.7em)
#show heading.where(level: 1): set text(size: 23pt)
#show heading.where(level: 2): set text(size: 15pt)
#show heading.where(level: 3): set text(size: 12pt)
#show link: set text(fill: accent)
#show raw: set text(font: ("JetBrains Mono", "DejaVu Serif", "DejaVu Sans", "Noto Sans SC"), size: 9pt)
#text(font: "JetBrains Mono", size: 8pt, fill: muted, tracking: 1pt, "GREAT MINDS / RESEARCH CONVERSATION")
#render(publication.tree)
#if cited.len() > 0 {
  heading(level: 2, "References")
  for (index, id) in cited.enumerate() {
    let note = notes.find(note => note.identifier == id)
    if note != none {
      labelled(block({
        set text(size: 9pt)
        grid(columns: (22pt, 1fr), text(str(index + 1) + "."), note.children.map(render).join())
      }), "note-" + id)
    }
  }
}
