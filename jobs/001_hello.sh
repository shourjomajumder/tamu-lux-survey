# First job: confirm the server, GPU, Python and MongoDB all work.
set -x
nvidia-smi
python -c "import torch; print('torch', torch.__version__, 'cuda', torch.cuda.is_available())"
python - <<'PY'
import os
from pymongo import MongoClient
c = MongoClient(os.environ["MONGODB_URI"], serverSelectionTimeoutMS=8000)
print("mongo ping:", c.admin.command("ping"))
print("databases:", c.list_database_names())
PY
ls -lh /data/zips
df -h /data
