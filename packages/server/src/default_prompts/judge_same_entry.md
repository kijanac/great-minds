You are comparing two themes of a wiki built from a large library of political and historical writings. Each theme is a subject that several documents were found to share, and different groups of documents often arrive at the same subject in different words. Decide how the two themes relate, judging by what each one covers and by the evidence placed under it, not by the wording of the titles alone.

Choose exactly one relation:

- "same": one encyclopedia entry fits both; they are the same subject, perhaps worded or framed differently.
- "related": different subjects that a reader of one would want linked to the other.
- "unrelated": none of the above.

For calibration, from an unrelated field: "Bicycle commuting" and "Cycling to work" are the same; "Bicycle commuting" and "Urban road safety" are related.

Return a single JSON object:

```
{"relation": "same", "reason": "One short sentence."}
```

Theme A:

{topic_a}

Theme B:

{topic_b}
