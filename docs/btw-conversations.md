# BTW conversations

A session is a standalone conversation. A BTW is a persistent, linear aside anchored to a document passage or a saved completed/stopped answer. Both own their history. Placement controls presentation; origin records where the thought began. An inline BTW cannot be the origin of another BTW.

An answer BTW inherits the latest usable selected parent when its first question is accepted. Selecting A1 after U2/A2 have completed includes U2/A2 in inherited context while the selected A1 passage remains the focus. Recorded parent/cutoff and annotation identity are separate. Subsequent parent replies and siblings are excluded; later BTW turns follow their own history plus fixed ancestry. Immediate-parent tool results are retained; older outputs use the existing omission marker.

Continue changes placement to standalone and the future reply default to query. It preserves the conversation ID, history, passage, inherited context and already accepted reply mode. The conversation then appears in the session list, and its origin links to it. Direct links to an inline BTW return to its origin. Ownership is checked, and repeating Continue is idempotent.

The continued conversation opens with its passage visible and selection highlighted. Inline BTWs and sessions share message presentation. Collapsed BTWs retain passage highlights with keyboard activation. An ambiguous repeated quote uses the paragraph marker rather than silently highlighting the wrong occurrence.

See [conversation authority, publication and cutover requirements](conversations.md). Historical conversion/recovery procedures and their evidence belong to the separate migration bundle, not the native runtime.
