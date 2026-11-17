$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'Start-Machine-Simulator.ps1')
Start-Process 'http://127.0.0.1:4176/machine'
