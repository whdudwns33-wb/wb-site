param([Parameter(Mandatory=$true)][ValidateSet('server','tunnel')][string]$Component)
$ErrorActionPreference = 'Stop'
$runtimeRoot = $PSScriptRoot

# Keep children in a job: forced Task Scheduler termination also closes this handle.
# https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class WorkbenchChildJob {
    [StructLayout(LayoutKind.Sequential)]
    struct BasicLimits {
        public long ProcessTime, JobTime;
        public uint Flags;
        public UIntPtr MinimumWorkingSet, MaximumWorkingSet;
        public uint ActiveProcesses;
        public UIntPtr Affinity;
        public uint Priority, Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct IoCounters {
        public ulong ReadOperations, WriteOperations, OtherOperations;
        public ulong ReadBytes, WriteBytes, OtherBytes;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct ExtendedLimits {
        public BasicLimits Basic;
        public IoCounters Io;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimits limits, uint size);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError=true)]
    public static extern bool CloseHandle(IntPtr handle);

    public static IntPtr Create() {
        if (IntPtr.Size != 8 || Marshal.SizeOf<BasicLimits>() != 64 || Marshal.SizeOf<ExtendedLimits>() != 144)
            throw new PlatformNotSupportedException("Workbench host requires 64-bit Windows PowerShell 7.");
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
        var limits = new ExtendedLimits();
        limits.Basic.Flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf<ExtendedLimits>())) {
            int error = Marshal.GetLastWin32Error();
            CloseHandle(job);
            throw new Win32Exception(error);
        }
        return job;
    }
    public static void Assign(IntPtr job, IntPtr process) {
        if (!AssignProcessToJobObject(job, process)) throw new Win32Exception(Marshal.GetLastWin32Error());
    }
}
'@

if ($Component -eq 'server') {
    $env:WB_WORKBENCH_DIR = Join-Path $runtimeRoot 'public'
    $env:PORT = '18960'
    $executable = 'C:\Program Files\nodejs\node.exe'
    $arguments = @((Join-Path $runtimeRoot 'serve.mjs'))
} else {
    $executable = 'C:\Users\wb\cloudflared\cloudflared.exe'
    $arguments = @('tunnel','--config',(Join-Path $runtimeRoot 'protected\tunnel.yml'),'--no-autoupdate','run')
}
$job = [WorkbenchChildJob]::Create()
$child = $null
$exitCode = 1
try {
    $child = Start-Process -FilePath $executable -ArgumentList $arguments -WorkingDirectory $runtimeRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $runtimeRoot "logs\$Component.stdout.log") -RedirectStandardError (Join-Path $runtimeRoot "logs\$Component.stderr.log")
    [WorkbenchChildJob]::Assign($job, $child.Handle)
    $child.WaitForExit()
    $exitCode = $child.ExitCode
} catch {
    if ($child -and !$child.HasExited) {
        $child.Kill($true)
        $child.WaitForExit()
    }
    throw
} finally {
    [void][WorkbenchChildJob]::CloseHandle($job)
    if ($child) { $child.Dispose() }
}
exit $exitCode
