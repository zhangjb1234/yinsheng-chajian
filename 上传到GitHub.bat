@echo off
cd /d %~dp0
title 推送到 GitHub
echo 正在推送到 GitHub...
echo 如果弹出登录窗口:选 "Sign in with your browser",浏览器里点绿色 Authorize 按钮
echo.
git push -u origin main
echo.
echo 仓库地址: https://github.com/zhangjb1234/moge
echo (看到 "Branch 'main' set up to track" 字样就是成功)
pause
