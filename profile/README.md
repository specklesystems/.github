![Speckle_Prod-V0-transparent](https://user-images.githubusercontent.com/7696515/164787216-f34b1cfb-5a08-4b12-a64a-9f65273c35dd.png)
<h1 align="center">
  <img src="https://user-images.githubusercontent.com/2679513/131189167-18ea5fe1-c578-47f6-9785-3748178e4312.png" width="150px"/><br/>
  Speckle - The Open Source Platform For 3D Data
</h1>

<p align="center"><a href="https://twitter.com/SpeckleSystems"><img src="https://img.shields.io/twitter/follow/SpeckleSystems?style=social" alt="Twitter Follow"></a> <a href="https://speckle.community"><img src="https://img.shields.io/discourse/users?server=https%3A%2F%2Fspeckle.community&amp;style=flat-square&amp;logo=discourse&amp;logoColor=white" alt="Community forum users"></a> <a href="https://speckle.systems"><img src="https://img.shields.io/badge/https://-speckle.systems-royalblue?style=flat-square" alt="website"></a> <a href="https://speckle.guide/dev/"><img src="https://img.shields.io/badge/docs-speckle.guide-orange?style=flat-square&amp;logo=read-the-docs&amp;logoColor=white" alt="docs"></a></p>


> Speckle makes 3D data work for both humans and machines. 
> 
> Our whole world - from buildings to planes - is being built from 3D models carefully articulated and thought through by architects, designers and engineers. 
Just like software engineering projects, people collaborate to create things greater than the sum of their parts. We're here to provide an open source base for automation and collaboration.

# Features

- **Object-based:** say goodbye to files! Speckle is the first object based platform for the AEC industry
- **Version control:** Speckle is the Git & Hub for geometry and BIM data
- **Collaboration:** share your designs collaborate with others
- **3D Viewer:** see your CAD and BIM models online, share and embed them anywhere
- **Interoperability:** get your CAD and BIM models into other software without exporting or importing
- **Real time:** get real time updates and notifications and changes
- **GraphQL API:** get what you need anywhere you want it
- **Webhooks:** the base for a automation and next-gen pipelines
- **Built for developers:** we are building Speckle with developers in mind and got tools for every stack
- **Built for the AEC industry:** Speckle connectors are plugins for the most common software used in the industry such as Revit, Rhino, Grasshopper, AutoCAD, Civil 3D, Excel, Unreal Engine, Unity, QGIS, Blender, ArchiCAD and more!

# Components

### Principles & SDKs 

Speckle is not a file based system - it's a versioned object graph storage for large 3D models, with multiple persistance layers. Read more about [the core architecture here](https://speckle.guide/dev/architecture.html).
What this means, in short, is that we decompose 3D data into their subconstituent atomic parts, hash them and store them in various places, such as databases, the [Speckle Server](https://github.com/specklesystems/speckle-server), or the file system. We allow you to access this data in a linear fashion, suited for various processing tasks, or in a structured manner, suited for authoring applications and human understanding.

- [.NET SDK](https://github.com/specklesystems/speckle-sharp/tree/main/Core) (part of our .NET monorepo)
- [Python SDK](https://github.com/specklesystems/specklepy)

### Connectors 

We take data out of design applications via a set of tightly integrated connectors that talk with the native APIs of the host application. Here are some of our connectors, at a glance:
- [Revit](https://github.com/specklesystems/speckle-sharp/tree/main/ConnectorRevit) & [Dynamo](https://github.com/specklesystems/speckle-sharp/tree/main/ConnectorDynamo)
- [Rhino](https://github.com/specklesystems/speckle-sharp/tree/main/ConnectorRhino) & [Grasshopper](https://github.com/specklesystems/speckle-sharp/tree/main/ConnectorGrasshopper)
- [Autocad](https://github.com/specklesystems/speckle-sharp/tree/main/ConnectorAutocadCivil)
- [Blender](https://github.com/specklesystems/speckle-blender)
- [Sketchup](https://github.com/specklesystems/speckle-sketchup)
- [QGIS](https://github.com/specklesystems/speckle-qgis)
- [Unreal](https://github.com/specklesystems/speckle-unreal)
- and more! 



### The Speckle Server

Our primary storage layer is the Speckle Server - where Speckle's object decomposition is backed by access control, a querying api, a snazzy frontend and online 3D viewer, and more. Here are some of the components, at a glance:

- [Speckle Server](https://github.com/specklesystems/speckle-server/blob/main/packages/server): the Server, a nodejs app. Core external dependencies are a Redis and Postgresql db.
- [Speckle Frontend](https://github.com/specklesystems/speckle-server/blob/main/packages/frontend): the Frontend, a static Vue app.
- [3D Viewer](https://github.com/specklesystems/speckle-server/blob/main/packages/viewer): a threejs extension that allows you to display 3D data [![npm version](https://camo.githubusercontent.com/dc69232cc57b77de6554e752dd6dfc60ca0ecdfbe91bdfcbf7c7531a511ec200/68747470733a2f2f62616467652e667572792e696f2f6a732f253430737065636b6c652532467669657765722e737667)](https://www.npmjs.com/package/@speckle/viewer)
- and more!

# Community & Contributions

At Speckle, we're a bunch of [slightly quirky humans](https://speckle.systems/about/) with mixed backgrounds from architecture, engineering, and, thankfully, computer science. We engage with the wider Speckle Community on [our forum](https://speckle.community/), join us! 
We also host regular [open office hours](https://speckle.community/t/community-standup/951/59), all are welcome! 




