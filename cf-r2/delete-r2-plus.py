import boto3
from botocore.config import Config
from datetime import datetime

# 配置 Cloudflare R2
ACCESS_KEY = ""  # 替换为你的 R2 Access Key ID
SECRET_KEY = ""  # 替换为你的 R2 Access Secret Key
ACCOUNT_ID = ""  # 替换为你的 Cloudflare Account ID
BUCKET_NAME = ""  # 替换为你的 R2 存储桶名称
KEEP_LATEST = 3  # 保留的最新文件数量

# 创建 S3 客户端
s3 = boto3.client('s3',
    endpoint_url=f'https://{ACCOUNT_ID}.r2.cloudflarestorage.com',
    aws_access_key_id=ACCESS_KEY,
    aws_secret_access_key=SECRET_KEY,
    config=Config(region_name='auto', signature_version='s3v4')
)

def get_sorted_files(bucket_name):
    """获取按修改时间排序的文件列表（最新在前）"""
    response = s3.list_objects_v2(Bucket=bucket_name)
    if 'Contents' not in response:
        return []
    
    # 提取文件Key和最后修改时间，并按时间降序排序
    files = [(obj['Key'], obj['LastModified']) for obj in response['Contents']]
    files.sort(key=lambda x: x[1], reverse=True)  # 按时间降序排列
    return files

def delete_old_files(bucket_name, keep=3):
    """保留最新的keep个文件，删除其他"""
    files = get_sorted_files(bucket_name)
    total_files = len(files)
    
    if total_files <= keep:
        print(f"无需删除，文件总数 {total_files} 小于等于需保留数 {keep}")
        return
    
    # 需要删除的文件（跳过前keep个最新文件）
    files_to_delete = files[keep:]
    delete_objects = [{'Key': file[0]} for file in files_to_delete]
    
    # 执行批量删除
    print(f"正在删除 {len(delete_objects)} 个旧文件（共 {total_files} 个文件）...")
    response = s3.delete_objects(
        Bucket=bucket_name,
        Delete={'Objects': delete_objects}
    )
    
    # 检查删除结果
    if 'Deleted' in response:
        print(f"成功删除 {len(response['Deleted'])} 个文件")
    if 'Errors' in response:
        print(f"删除失败 {len(response['Errors'])} 个文件")
        for error in response['Errors']:
            print(f"Key: {error['Key']}, 错误: {error['Message']}")

# 执行删除操作
delete_old_files(BUCKET_NAME, KEEP_LATEST)