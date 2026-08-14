using HIDMaestro;

namespace Ksx.HidMaestroProbe;

/// <summary>
/// Makes SDK catalog-surface drift a compiler error while keeping the probe's
/// runtime path reflection-only. This method is deliberately never invoked:
/// constructing HMContext in v1.6.1 starts background payload extraction.
/// </summary>
internal static class CompileTimeSdkContract
{
    internal static object ReadCatalogSurface(HMContext context, HMProfile profile)
    {
        IReadOnlyList<HMProfile> profiles = context.AllProfiles;
        HMProfile? selected = context.GetProfile(profile.Id);

        return new
        {
            profiles,
            selected,
            profile.Id,
            profile.Name,
            profile.Vendor,
            profile.VendorId,
            profile.ProductId,
            profile.ProductString,
            profile.ManufacturerString,
            profile.Type,
            profile.Connection,
            profile.DriverMode,
            profile.TriggerMode,
            profile.Backend,
            profile.IsDeployable,
            profile.InputReportSize,
            profile.ButtonCount,
            profile.AxisCount,
            profile.HasHat,
        };
    }
}
