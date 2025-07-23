- Add search bar log to cloud functionality to frontend search bar (every 0.5 seconds check for changed search bar and call api, from api store in database)
- Retry on expired token errors during movie segment upload




```
0|media-library-source-worker  | ❌ Failed to upload segment segment_000314.ts: ExpiredToken: The provided token has expired.
0|media-library-source-worker  |     at throwDefaultError (/app/node_modules/@smithy/smithy-client/dist-cjs/index.js:388:20)
0|media-library-source-worker  |     at /app/node_modules/@smithy/smithy-client/dist-cjs/index.js:397:5
0|media-library-source-worker  |     at de_CommandError (/app/node_modules/@aws-sdk/client-s3/dist-cjs/index.js:5022:14)
0|media-library-source-worker  |     at process.processTicksAndRejections (node:internal/process/task_queues:95:5)
0|media-library-source-worker  |     at async /app/node_modules/@smithy/middleware-serde/dist-cjs/index.js:36:20
0|media-library-source-worker  |     at async /app/node_modules/@aws-sdk/middleware-sdk-s3/dist-cjs/index.js:484:18
0|media-library-source-worker  |     at async /app/node_modules/@smithy/middleware-retry/dist-cjs/index.js:320:38
0|media-library-source-worker  |     at async /app/node_modules/@aws-sdk/middleware-sdk-s3/dist-cjs/index.js:110:22
0|media-library-source-worker  |     at async /app/node_modules/@aws-sdk/middleware-sdk-s3/dist-cjs/index.js:137:14
0|media-library-source-worker  |     at async /app/node_modules/@aws-sdk/middleware-logger/dist-cjs/index.js:33:22 {
0|media-library-source-worker  |   '$fault': 'client',
0|media-library-source-worker  |   '$metadata': {
0|media-library-source-worker  |     httpStatusCode: 400,
0|media-library-source-worker  |     requestId: '8CPWNVHKNQNQ0E37',
0|media-library-source-worker  |     extendedRequestId: '5WW5BnvwDqApiM0uLrKrBOx/InXWGkCzf6O/J7juqQjulnsFMEjoGD+0hYmhY3LWMajIn7+oP0o=',
0|media-library-source-worker  |     cfId: undefined,
0|media-library-source-worker  |     attempts: 1,
0|media-library-source-worker  |     totalRetryDelay: 0
0|media-library-source-worker  |   },
0|media-library-source-worker  |   Code: 'ExpiredToken',
0|media-library-source-worker  |   'Token-0': 'IQoJb3JpZ2luX2VjEOj//////////wEaCXVzLWVhc3QtMSJGMEQCIHp9JeWl2glcqyGCgW00LzcDah7OwctafC7KsO90DKpCAiBRTrpRVOPQLabRHytCRcnl5Zswke3pXFluFUl8/5DNNyrEBAgQEAMaDDczODEyMzU5MDM4MyIMenerxSM/uxUYryD9KqEEIayyYZPvz138u8H1i+sRYGyyo77buy0ASrUOwrA9LIH7rmmZDcdu1NpDMIBQfBhaxnvH5nwysrTBRy9/SmR/WWyC2ZpW0wR7y44GDC8Q2EgH3XIQWNqYgVi6t2B97CbR/QS/y5Lbiiglnz3Yx/CUIIPv6zKjJLmzbZh/bIBuedyfw5VrTgJv5KIWyRG9tqd22GjL2C5xcu6BpecpbJ8EHnrjXyGZfLMQ8LNI9VWyBUP9DmJw11mjq4rdHBhWuTCAZU4tKdngOaLBX+uWm89WRo0aF6x1WDmPHP83ZPYh9K2oQxf9hKzE2SAxAhuXndrO5d8w9TaVQ+0APDcRWdVsJUzpqvivSBLWTPj59G5tHS4Ma9PkFG6mmnR/idjKRhVJoRWAY4IYzqgLHU/svMMLVAuX5zJRCJnaFKnbIGaUjKXFBTcj/wDRfI3RyTVU9qoTxS+ByHZkTebKzNGLO1edi47D9HYnboXAO6allQcxZSjNlLWGD9kAcrP0n3eUTwpCeQUXd21gUmdJyNpZfP2S72yCuZxSLewhBRBR/yshksQmSnqV024RVxmO/dSPJ507Jh6RpFKu0lqleUZkHbojC1EVwZ1wfT2N2EPH3xy5lclY9Blto7XHpsWjZRSXONHKzmKUIIkh24k+/2zW4rKqJGBi7ktgwYbirb/i/nhV8PfDBfnsUttsfiZy6m6lkw6/VFxKC77HPN1x2QUq0yEbtUQw9ZKCxAY6hgLgn4ZkLLbpPqukvVcOjUPjEijqGQNmCyJ3ncM/ACJ7SIzB9I3sMXHx3wm7exJ93qW4t4AaE3wa6zai27gjr1+UssdtAViyFG2CdYSOlfoseOueRK0kHJDWLPFHJJCANVPocRo9RikOsMnPrEMpTgD6wdMzDhEh0Cmk7WsStEu2PB2lBTD5TG3SAIDY6yDnGl1x6msNUt6ORkZppEbLswQyP4aWpGS6NDLCUG7mUjg7zzqrjCK28GGoSb4dCbVr9Wbt7lGohjDaf9YHZycsm0XyeTmgI8j6Jag/+NHv3yoKxU8x52ieXisDZ3PFWB4bRn6TkYzUmjPulXdBBDkZ2A5QtKVHrAJn',0|media-library-source-worker  |   RequestId: '8CPWNVHKNQNQ0E37',
0|media-library-source-worker  |   HostId: '5WW5BnvwDqApiM0uLrKrBOx/InXWGkCzf6O/J7juqQjulnsFMEjoGD+0hYmhY3LWMajIn7+oP0o='
0|media-library-source-worker  | }
0|media-library-source-worker  | ❌ Failed to upload segment segment_000315.ts: ExpiredToken: The provided token has expired.
0|media-library-source-worker  |     at throwDefaultError (/app/node_modules/@smithy/smithy-client/dist-cjs/index.js:388:20)
0|media-library-source-worker  |     at /app/node_modules/@smithy/smithy-client/dist-cjs/index.js:397:5
0|media-library-source-worker  |     at de_CommandError (/app/node_modules/@aws-sdk/client-s3/dist-cjs/index.js:5022:14)
0|media-library-source-worker  |     at process.processTicksAndRejections (node:internal/process/task_queues:95:5)
0|media-library-source-worker  |     at async /app/node_modules/@smithy/middleware-serde/dist-cjs/index.js:36:20
0|media-library-source-worker  |     at async /app/node_modules/@aws-sdk/middleware-sdk-s3/dist-cjs/index.js:484:18
0|media-library-source-worker  |     at async /app/node_modules/@smithy/middleware-retry/dist-cjs/index.js:320:38
0|media-library-source-worker  |     at async /app/node_modules/@aws-sdk/middleware-sdk-s3/dist-cjs/index.js:110:22
0|media-library-source-worker  |     at async /app/node_modules/@aws-sdk/middleware-sdk-s3/dist-cjs/index.js:137:14
0|media-library-source-worker  |     at async /app/node_modules/@aws-sdk/middleware-logger/dist-cjs/index.js:33:22 {
0|media-library-source-worker  |   '$fault': 'client',
0|media-library-source-worker  |   '$metadata': {
0|media-library-source-worker  |     httpStatusCode: 400,
0|media-library-source-worker  |     requestId: '8CPJ1C3H1TNZBZEJ',
0|media-library-source-worker  |     extendedRequestId: 'RdGpFfrBYry+Piczo/gxlKmVvBeGlcxltxVR7M251n+wlVJfTcumwoxFVrzjsyzdlH1OaEjIhoU=',
0|media-library-source-worker  |     cfId: undefined,
0|media-library-source-worker  |     attempts: 1,
0|media-library-source-worker  |     totalRetryDelay: 0
0|media-library-source-worker  |   },
0|media-library-source-worker  |   Code: 'ExpiredToken',
0|media-library-source-worker  |   'Token-0': 'IQoJb3JpZ2luX2VjEOj//////////wEaCXVzLWVhc3QtMSJGMEQCIHp9JeWl2glcqyGCgW00LzcDah7OwctafC7KsO90DKpCAiBRTrpRVOPQLabRHytCRcnl5Zswke3pXFluFUl8/5DNNyrEBAgQEAMaDDczODEyMzU5MDM4MyIMenerxSM/uxUYryD9KqEEIayyYZPvz138u8H1i+sRYGyyo77buy0ASrUOwrA9LIH7rmmZDcdu1NpDMIBQfBhaxnvH5nwysrTBRy9/SmR/WWyC2ZpW0wR7y44GDC8Q2EgH3XIQWNqYgVi6t2B97CbR/QS/y5Lbiiglnz3Yx/CUIIPv6zKjJLmzbZh/bIBuedyfw5VrTgJv5KIWyRG9tqd22GjL2C5xcu6BpecpbJ8EHnrjXyGZfLMQ8LNI9VWyBUP9DmJw11mjq4rdHBhWuTCAZU4tKdngOaLBX+uWm89WRo0aF6x1WDmPHP83ZPYh9K2oQxf9hKzE2SAxAhuXndrO5d8w9TaVQ+0APDcRWdVsJUzpqvivSBLWTPj59G5tHS4Ma9PkFG6mmnR/idjKRhVJoRWAY4IYzqgLHU/svMMLVAuX5zJRCJnaFKnbIGaUjKXFBTcj/wDRfI3RyTVU9qoTxS+ByHZkTebKzNGLO1edi47D9HYnboXAO6allQcxZSjNlLWGD9kAcrP0n3eUTwpCeQUXd21gUmdJyNpZfP2S72yCuZxSLewhBRBR/yshksQmSnqV024RVxmO/dSPJ507Jh6RpFKu0lqleUZkHbojC1EVwZ1wfT2N2EPH3xy5lclY9Blto7XHpsWjZRSXONHKzmKUIIkh24k+/2zW4rKqJGBi7ktgwYbirb/i/nhV8PfDBfnsUttsfiZy6m6lkw6/VFxKC77HPN1x2QUq0yEbtUQw9ZKCxAY6hgLgn4ZkLLbpPqukvVcOjUPjEijqGQNmCyJ3ncM/ACJ7SIzB9I3sMXHx3wm7exJ93qW4t4AaE3wa6zai27gjr1+UssdtAViyFG2CdYSOlfoseOueRK0kHJDWLPFHJJCANVPocRo9RikOsMnPrEMpTgD6wdMzDhEh0Cmk7WsStEu2PB2lBTD5TG3SAIDY6yDnGl1x6msNUt6ORkZppEbLswQyP4aWpGS6NDLCUG7mUjg7zzqrjCK28GGoSb4dCbVr9Wbt7lGohjDaf9YHZycsm0XyeTmgI8j6Jag/+NHv3yoKxU8x52ieXisDZ3PFWB4bRn6TkYzUmjPulXdBBDkZ2A5QtKVHrAJn',0|media-library-source-worker  |   RequestId: '8CPJ1C3H1TNZBZEJ',
0|media-library-source-worker  |   HostId: 'RdGpFfrBYry+Piczo/gxlKmVvBeGlcxltxVR7M251n+wlVJfTcumwoxFVrzjsyzdlH1OaEjIhoU='
0|media-library-source-worker  | }
0|media-library-source-worker  | Failed to update status: 403 {"message":"The security token included in the request is expired"}
0|media-library-source-worker  | ❌ Upload failed for movie: VGhlIERldmlsIFdlYXJzIFByYWRhL1RoZSBEZXZpbCBXZWFycyBQcmFkYSAoMjAwNikvVGhlIERldmlsIFdlYXJzIFByYWRhICgyMDA2KSBbMTA4MHAueDI2NV0ubWt2 ExpiredToken: The provided token has expired.
0|media-library-source-worker  |     at throwDefaultError (/app/node_modules/@smithy/smithy-client/dist-cjs/index.js:388:20)
0|media-library-source-worker  |     at /app/node_modules/@smithy/smithy-client/dist-cjs/index.js:397:5
0|media-library-source-worker  |     at de_CommandError (/app/node_modules/@aws-sdk/client-s3/dist-cjs/index.js:5022:14)
0|media-library-source-worker  |     at process.processTicksAndRejections (node:internal/process/task_queues:95:5)
0|media-library-source-worker  |     at async /app/node_modules/@smithy/middleware-serde/dist-cjs/index.js:36:20
0|media-library-source-worker  |     at async /app/node_modules/@aws-sdk/middleware-sdk-s3/dist-cjs/index.js:484:18
0|media-library-source-worker  |     at async /app/node_modules/@smithy/middleware-retry/dist-cjs/index.js:320:38
0|media-library-source-worker  |     at async /app/node_modules/@aws-sdk/middleware-sdk-s3/dist-cjs/index.js:110:22
0|media-library-source-worker  |     at async /app/node_modules/@aws-sdk/middleware-sdk-s3/dist-cjs/index.js:137:14
0|media-library-source-worker  |     at async /app/node_modules/@aws-sdk/middleware-logger/dist-cjs/index.js:33:22 {
0|media-library-source-worker  |   '$fault': 'client',
0|media-library-source-worker  |   '$metadata': {
0|media-library-source-worker  |     httpStatusCode: 400,
0|media-library-source-worker  |     requestId: '9ZCCN2REVZR2Y2VF',
0|media-library-source-worker  |     extendedRequestId: 'zC2naGX5Lqg1End/OOuV9wm/vnmJTDpa1anWAzvSvOY0QGsKULIJOpV3GrsXMrjhJhHf/eqIz3Y=',
0|media-library-source-worker  |     cfId: undefined,
0|media-library-source-worker  |     attempts: 1,
0|media-library-source-worker  |     totalRetryDelay: 0
0|media-library-source-worker  |   },
0|media-library-source-worker  |   Code: 'ExpiredToken',
0|media-library-source-worker  |   'Token-0': 'IQoJb3JpZ2luX2VjEOj//////////wEaCXVzLWVhc3QtMSJGMEQCIHp9JeWl2glcqyGCgW00LzcDah7OwctafC7KsO90DKpCAiBRTrpRVOPQLabRHytCRcnl5Zswke3pXFluFUl8/5DNNyrEBAgQEAMaDDczODEyMzU5MDM4MyIMenerxSM/uxUYryD9KqEEIayyYZPvz138u8H1i+sRYGyyo77buy0ASrUOwrA9LIH7rmmZDcdu1NpDMIBQfBhaxnvH5nwysrTBRy9/SmR/WWyC2ZpW0wR7y44GDC8Q2EgH3XIQWNqYgVi6t2B97CbR/QS/y5Lbiiglnz3Yx/CUIIPv6zKjJLmzbZh/bIBuedyfw5VrTgJv5KIWyRG9tqd22GjL2C5xcu6BpecpbJ8EHnrjXyGZfLMQ8LNI9VWyBUP9DmJw11mjq4rdHBhWuTCAZU4tKdngOaLBX+uWm89WRo0aF6x1WDmPHP83ZPYh9K2oQxf9hKzE2SAxAhuXndrO5d8w9TaVQ+0APDcRWdVsJUzpqvivSBLWTPj59G5tHS4Ma9PkFG6mmnR/idjKRhVJoRWAY4IYzqgLHU/svMMLVAuX5zJRCJnaFKnbIGaUjKXFBTcj/wDRfI3RyTVU9qoTxS+ByHZkTebKzNGLO1edi47D9HYnboXAO6allQcxZSjNlLWGD9kAcrP0n3eUTwpCeQUXd21gUmdJyNpZfP2S72yCuZxSLewhBRBR/yshksQmSnqV024RVxmO/dSPJ507Jh6RpFKu0lqleUZkHbojC1EVwZ1wfT2N2EPH3xy5lclY9Blto7XHpsWjZRSXONHKzmKUIIkh24k+/2zW4rKqJGBi7ktgwYbirb/i/nhV8PfDBfnsUttsfiZy6m6lkw6/VFxKC77HPN1x2QUq0yEbtUQw9ZKCxAY6hgLgn4ZkLLbpPqukvVcOjUPjEijqGQNmCyJ3ncM/ACJ7SIzB9I3sMXHx3wm7exJ93qW4t4AaE3wa6zai27gjr1+UssdtAViyFG2CdYSOlfoseOueRK0kHJDWLPFHJJCANVPocRo9RikOsMnPrEMpTgD6wdMzDhEh0Cmk7WsStEu2PB2lBTD5TG3SAIDY6yDnGl1x6msNUt6ORkZppEbLswQyP4aWpGS6NDLCUG7mUjg7zzqrjCK28GGoSb4dCbVr9Wbt7lGohjDaf9YHZycsm0XyeTmgI8j6Jag/+NHv3yoKxU8x52ieXisDZ3PFWB4bRn6TkYzUmjPulXdBBDkZ2A5QtKVHrAJn',0|media-library-source-worker  |   RequestId: '9ZCCN2REVZR2Y2VF',
0|media-library-source-worker  |   HostId: 'zC2naGX5Lqg1End/OOuV9wm/vnmJTDpa1anWAzvSvOY0QGsKULIJOpV3GrsXMrjhJhHf/eqIz3Y='
0|media-library-source-worker  | }
0|media-library-source-worker  | ❌ Upload failed for movie: VGhlIERldmlsIFdlYXJzIFByYWRhL1RoZSBEZXZpbCBXZWFycyBQcmFkYSAoMjAwNikvVGhlIERldmlsIFdlYXJzIFByYWRhICgyMDA2KSBbMTA4MHAueDI2NV0ubWt2 ExpiredToken: The provided token has expired.
0|media-library-source-worker  |     at throwDefaultError (/app/node_modules/@smithy/smithy-client/dist-cjs/index.js:388:20)
0|media-library-source-worker  |     at /app/node_modules/@smithy/smithy-client/dist-cjs/index.js:397:5
0|media-library-source-worker  |     at de_CommandError (/app/node_modules/@aws-sdk/client-s3/dist-cjs/index.js:5022:14)
0|media-library-source-worker  |     at process.processTicksAndRejections (node:internal/process/task_queues:95:5)
0|media-library-source-worker  |     at async /app/node_modules/@smithy/middleware-serde/dist-cjs/index.js:36:20
0|media-library-source-worker  |     at async /app/node_modules/@aws-sdk/middleware-sdk-s3/dist-cjs/index.js:484:18
0|media-library-source-worker  |     at async /app/node_modules/@smithy/middleware-retry/dist-cjs/index.js:320:38
0|media-library-source-worker  |     at async /app/node_modules/@aws-sdk/middleware-sdk-s3/dist-cjs/index.js:110:22
0|media-library-source-worker  |     at async /app/node_modules/@aws-sdk/middleware-sdk-s3/dist-cjs/index.js:137:14
0|media-library-source-worker  |     at async /app/node_modules/@aws-sdk/middleware-logger/dist-cjs/index.js:33:22 {
0|media-library-source-worker  |   '$fault': 'client',
0|media-library-source-worker  |   '$metadata': {
0|media-library-source-worker  |     httpStatusCode: 400,
0|media-library-source-worker  |     requestId: '9ZCCN2REVZR2Y2VF',
0|media-library-source-worker  |     extendedRequestId: 'zC2naGX5Lqg1End/OOuV9wm/vnmJTDpa1anWAzvSvOY0QGsKULIJOpV3GrsXMrjhJhHf/eqIz3Y=',
0|media-library-source-worker  |     cfId: undefined,
0|media-library-source-worker  |     attempts: 1,
0|media-library-source-worker  |     totalRetryDelay: 0
0|media-library-source-worker  |   },
0|media-library-source-worker  |   Code: 'ExpiredToken',
0|media-library-source-worker  |   'Token-0': 'IQoJb3JpZ2luX2VjEOj//////////wEaCXVzLWVhc3QtMSJGMEQCIHp9JeWl2glcqyGCgW00LzcDah7OwctafC7KsO90DKpCAiBRTrpRVOPQLabRHytCRcnl5Zswke3pXFluFUl8/5DNNyrEBAgQEAMaDDczODEyMzU5MDM4MyIMenerxSM/uxUYryD9KqEEIayyYZPvz138u8H1i+sRYGyyo77buy0ASrUOwrA9LIH7rmmZDcdu1NpDMIBQfBhaxnvH5nwysrTBRy9/SmR/WWyC2ZpW0wR7y44GDC8Q2EgH3XIQWNqYgVi6t2B97CbR/QS/y5Lbiiglnz3Yx/CUIIPv6zKjJLmzbZh/bIBuedyfw5VrTgJv5KIWyRG9tqd22GjL2C5xcu6BpecpbJ8EHnrjXyGZfLMQ8LNI9VWyBUP9DmJw11mjq4rdHBhWuTCAZU4tKdngOaLBX+uWm89WRo0aF6x1WDmPHP83ZPYh9K2oQxf9hKzE2SAxAhuXndrO5d8w9TaVQ+0APDcRWdVsJUzpqvivSBLWTPj59G5tHS4Ma9PkFG6mmnR/idjKRhVJoRWAY4IYzqgLHU/svMMLVAuX5zJRCJnaFKnbIGaUjKXFBTcj/wDRfI3RyTVU9qoTxS+ByHZkTebKzNGLO1edi47D9HYnboXAO6allQcxZSjNlLWGD9kAcrP0n3eUTwpCeQUXd21gUmdJyNpZfP2S72yCuZxSLewhBRBR/yshksQmSnqV024RVxmO/dSPJ507Jh6RpFKu0lqleUZkHbojC1EVwZ1wfT2N2EPH3xy5lclY9Blto7XHpsWjZRSXONHKzmKUIIkh24k+/2zW4rKqJGBi7ktgwYbirb/i/nhV8PfDBfnsUttsfiZy6m6lkw6/VFxKC77HPN1x2QUq0yEbtUQw9ZKCxAY6hgLgn4ZkLLbpPqukvVcOjUPjEijqGQNmCyJ3ncM/ACJ7SIzB9I3sMXHx3wm7exJ93qW4t4AaE3wa6zai27gjr1+UssdtAViyFG2CdYSOlfoseOueRK0kHJDWLPFHJJCANVPocRo9RikOsMnPrEMpTgD6wdMzDhEh0Cmk7WsStEu2PB2lBTD5TG3SAIDY6yDnGl1x6msNUt6ORkZppEbLswQyP4aWpGS6NDLCUG7mUjg7zzqrjCK28GGoSb4dCbVr9Wbt7lGohjDaf9YHZycsm0XyeTmgI8j6Jag/+NHv3yoKxU8x52ieXisDZ3PFWB4bRn6TkYzUmjPulXdBBDkZ2A5QtKVHrAJn',0|media-library-source-worker  |   RequestId: '9ZCCN2REVZR2Y2VF',
0|media-library-source-worker  |   HostId: 'zC2naGX5Lqg1End/OOuV9wm/vnmJTDpa1anWAzvSvOY0QGsKULIJOpV3GrsXMrjhJhHf/eqIz3Y='
0|media-library-source-worker  | }
```
