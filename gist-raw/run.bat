@echo off
chcp 65001 > nul
setlocal enabledelayedexpansion

:: 配置环境路径（根据实际安装路径修改）
set "BASH_CMD=D:\Program Files\Git\bin\bash.exe"
set "SCRIPT_PATH=%~dp0upload_to_gist.sh"

:: 检查Bash是否存在
if not exist "%BASH_CMD%" (
    echo 错误：未找到Git Bash，请确保已安装Git for Windows。
    pause
    exit /b 1
)

:: 检查脚本是否存在
if not exist "%SCRIPT_PATH%" (
    echo 错误：未找到脚本文件 %SCRIPT_PATH%
    pause
    exit /b 1
)

:: 增强路径处理
set "args="
for %%a in (%*) do (
    set "win_path=%%~a"
    set "win_path=!win_path:'=''!"  # 处理单引号问题
    
    :: 使用更安全的路径转换方式
    "%BASH_CMD%" -c "cygpath -u '!win_path!'" > temp_path.txt
    set /p unix_path=<temp_path.txt
    del temp_path.txt
    
    set "args=!args! '!unix_path!'"
)

:: 执行脚本并捕获错误
"%BASH_CMD%" -lc "'%SCRIPT_PATH%' !args!"
set "exit_code=!errorlevel!"

:: 错误处理
if !exit_code! neq 0 (
    echo.
    echo 错误：脚本执行失败 (代码 !exit_code!)
    pause
)

endlocal
exit /b !exit_code!
