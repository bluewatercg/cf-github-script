import boto3
from botocore.config import Config

# 配置 Cloudflare R2
ACCESS_KEY = ""  # 替换为你的 R2 Access Key ID
SECRET_KEY = ""  # 替换为你的 R2 Access Secret Key
ACCOUNT_ID = ""  # 替换为你的 Cloudflare Account ID
BUCKET_NAME = ""  # 替换为你的 R2 存储桶名称

r2_config = Config(
    region_name='auto',  # R2 使用 'auto' 作为 region
    signature_version='s3v4',
)

# 创建 S3 客户端
s3 = boto3.client('s3',
                  endpoint_url=f'https://{ACCOUNT_ID}.r2.cloudflarestorage.com',
                  aws_access_key_id=ACCESS_KEY,
                  aws_secret_access_key=SECRET_KEY,
                  config=r2_config)

# 获取存储桶中的文件列表
def list_files(bucket_name):
    response = s3.list_objects_v2(Bucket=bucket_name)
    if 'Contents' in response:
        return [{'Key': obj['Key']} for obj in response['Contents']]
    return []

# 删除存储桶中的所有文件
def delete_files(bucket_name):
    objects_to_delete = list_files(bucket_name)
    if objects_to_delete:
        delete_response = s3.delete_objects(Bucket=bucket_name, Delete={'Objects': objects_to_delete})
        print(f"已从 {bucket_name} 中删除 {len(objects_to_delete)} 个文件。")
    else:
        print(f"存储桶 {bucket_name} 是空的。")

# 执行删除操作
delete_files(BUCKET_NAME)