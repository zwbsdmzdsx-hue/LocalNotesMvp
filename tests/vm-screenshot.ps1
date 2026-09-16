param(
    [string]$VmName = 'Minifilter test',
    [string]$OutputPath = "$PSScriptRoot\vm-screen.png",
    [uint16]$Width = 1280,
    [uint16]$Height = 720
)
$ErrorActionPreference = 'Stop'
$vm = Get-CimInstance -Namespace root/virtualization/v2 -ClassName Msvm_ComputerSystem |
    Where-Object ElementName -eq $VmName
if (@($vm).Count -ne 1) { throw 'Expected one running test VM.' }
$service = Get-CimInstance -Namespace root/virtualization/v2 -ClassName Msvm_VirtualSystemManagementService
$result = Invoke-CimMethod -InputObject $service -MethodName GetVirtualSystemThumbnailImage -Arguments @{
    TargetSystem = $vm; WidthPixels = $Width; HeightPixels = $Height
}
if ($result.ReturnValue -ne 0) { throw "Screenshot failed: $($result.ReturnValue)" }
Add-Type -AssemblyName System.Drawing
$bitmap = New-Object System.Drawing.Bitmap([int]$Width, [int]$Height, [System.Drawing.Imaging.PixelFormat]::Format16bppRgb565)
$rect = New-Object System.Drawing.Rectangle(0, 0, [int]$Width, [int]$Height)
$bits = $bitmap.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::WriteOnly, [System.Drawing.Imaging.PixelFormat]::Format16bppRgb565)
try {
    $pixelLength = [int]$Width * [int]$Height * 2
    if ($result.ImageData.Length -ne $pixelLength + 4) { throw 'Unexpected Hyper-V image length.' }
    [System.Runtime.InteropServices.Marshal]::Copy([byte[]]$result.ImageData, 4, $bits.Scan0, $pixelLength)
}
finally { $bitmap.UnlockBits($bits) }
try { $bitmap.Save($OutputPath, [System.Drawing.Imaging.ImageFormat]::Png) }
finally { $bitmap.Dispose() }
Write-Output $OutputPath
