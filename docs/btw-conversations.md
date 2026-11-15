# BTW conversations

A conversation either stands alone or is anchored to a passage: in a document, or in a saved completed/stopped answer of another conversation. An anchored conversation is a BTW. Every conversation owns its history, has its own page and appears in the conversation list with its anchor. Anchors nest: an answer inside a BTW can anchor another BTW.

The web app shows a BTW inline beside its passage or on its full page. Both views use the same conversation state and controls (ask, Stop, retry, reconnect); opening the full page changes nothing stored. Each question records whether it was asked inline: inline questions get the BTW prompt and a brief-answer cue, other questions the default prompt and a softer length cue. A request without that flag uses the conversation's placement default, which the CLI and MCP still rely on.

An answer BTW inherits the latest usable selected parent when its first question is accepted. Selecting A1 after U2/A2 have completed includes U2/A2 in inherited context while the selected A1 passage remains the focus. Recorded parent/cutoff and annotation identity are separate. Subsequent parent replies and siblings are excluded; later BTW turns follow their own history plus fixed ancestry. Immediate-parent tool results are retained; older outputs use the existing omission marker.

Continue, still offered by the CLI and MCP, changes placement to standalone and the future reply default to query. It preserves the conversation ID, history, passage, inherited context and already accepted reply mode. Ownership is checked, and repeating Continue is idempotent.

A BTW's full page opens with its question and selected quotation visible; surrounding passage context can be expanded without changing the saved or inherited context. Collapsed BTWs retain passage highlights with keyboard activation. An ambiguous repeated quote uses the paragraph marker rather than silently highlighting the wrong occurrence.

See [conversation authority, publication and cutover requirements](conversations.md). Historical conversion/recovery procedures and their evidence belong to the separate migration bundle, not the native runtime.
