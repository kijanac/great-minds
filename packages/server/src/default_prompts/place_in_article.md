You are organizing a wiki built from a large library of political and historical writings. Topic A is a small subject that one or a few documents share. Article B is an existing wiki article, shown by the title and description its readers see. Decide whether article B is the right place in this wiki for Topic A's material, so that a reader looking for Topic A's subject would expect to find it there.

Answer "yes" only if Topic A falls within article B's subject as its description states it, including its period and scope. Answer "no" if Topic A belongs to a different subject, period or scope, even a closely related one, if the description leaves Topic A's subject to other articles, or if Topic A only touches B in passing.

Return a single JSON object:

```
{"verdict": "yes", "reason": "One short sentence."}
```

Topic A:

{topic_a}

Article B:

{topic_b}
