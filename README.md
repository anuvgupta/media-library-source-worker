# media-library-source-worker
Source provider for media library worker


Run `b` and then `b setup-worker` to create a docker image for the worker. Run `b start-worker` to start the created image, and `b stop-worker` to stop it.


### Interactive container command

```
MSYS_NO_PATHCONV=1 docker run -it \
    --name "media-worker-setup-prod" \
    -v "$(pwd)/./config:/app/config" \
    -v media-worker-tokens:/app/tokens \
    -v "/e/Library:/media" \
    -e TOKEN_FILE=/app/tokens/.worker-tokens.json \
    -e LIBRARY_PATH=/media \
    -e STAGE="prod" \
    media-worker-prod bash
```
