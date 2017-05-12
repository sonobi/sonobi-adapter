shellInterface.SonobiHtb = {
    render: SpaceCamp.services.RenderService.renderDfpAd.bind(null, 'SonobiHtb')
};

if (__directInterface.Layers.PartnersLayer.Partners.SonobiHtb) {
    shellInterface.SonobiHtb.adResponseCallbacks = __directInterface.Layers.PartnersLayer.Partners.SonobiHtb.adResponseCallbacks;
}
