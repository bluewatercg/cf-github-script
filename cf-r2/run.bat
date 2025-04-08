@echo off

bash ./install-boto3.sh
pause
python delete-r2.py
pause