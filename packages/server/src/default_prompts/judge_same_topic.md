You are comparing two topics proposed for a wiki built from a large library of political and historical writings. Each topic was proposed from one source document, and different documents often propose the same topic in different words. Decide how the two topics relate, judging by what each one covers and by the evidence placed under it, not by the wording of the titles alone.

Choose exactly one relation:

- "same": one article should cover both; they are the same subject, perhaps worded, framed or dated differently.
- "related": different subjects that a reader of one would want linked to the other.
- "unrelated": none of the above.

For calibration, from an unrelated field: "Bicycle commuting" and "Cycling to work" are the same; "Bicycle commuting" and "Urban road safety" are related.

Return a single JSON object:

```
{"relation": "same", "reason": "One short sentence."}
```

Topic A:

{topic_a}

Topic B:

{topic_b}
