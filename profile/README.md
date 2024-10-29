![Speckle](https://github.com/user-attachments/assets/184c3e68-95f9-4f52-9e71-81b9a1ab1956)
<h1 align="center">
  <img src="https://user-images.githubusercontent.com/2679513/131189167-18ea5fe1-c578-47f6-9785-3748178e4312.png" width="150px"/><br/>
  Speckle - Your AEC Data Hub
</h1>

<p align="center"><a href="https://twitter.com/SpeckleSystems"><img src="https://img.shields.io/twitter/follow/SpeckleSystems?style=social" alt="Twitter Follow"></a> <a href="https://speckle.community"><img src="https://img.shields.io/discourse/users?server=https%3A%2F%2Fspeckle.community&amp;style=flat-square&amp;logo=discourse&amp;logoColor=white" alt="Community forum users"></a> <a href="https://speckle.systems"><img src="https://img.shields.io/badge/https://-speckle.systems-royalblue?style=flat-square" alt="website"></a> <a href="https://speckle.guide/dev/"><img src="https://img.shields.io/badge/docs-speckle.guide-orange?style=flat-square&amp;logo=read-the-docs&amp;logoColor=white" alt="docs"></a></p>


> Speckle is the first AEC data hub that connects with your favorite AEC tools. Speckle exists to overcome the challenges of working in a fragmented industry where communication, creative workflows, and the exchange of data are often hindered by siloed software and processes. It is here to make the industry better.

# Features

- **Object-based:** say goodbye to files! Speckle is the first object based platform for the AEC industry
- **Version control:** Speckle is the Git & Hub for geometry and BIM data
- **Collaboration:** share your designs collaborate with others
- **3D Viewer:** see your CAD and BIM models online, share and embed them anywhere
- **Data Connectivity:** get your CAD and BIM models into other software without exporting or importing
- **Real time:** get real time updates and notifications and changes
- **Automate:** full on CI/CD pipelines on top of your Speckle data, the first of its kind in AEC
- **GraphQL API:** get what you need anywhere you want it
- **Webhooks:** the base for a automation and next-gen pipelines
- **Workspaces:** built for teams and designed to make you more productive as a group while benefiting from higher security, better permission management, and stronger collaboration
- **Built for developers:** we are building Speckle with developers in mind and got tools for every stack
- **Built for the AEC industry:** Speckle connectors are plugins for the most common software used in the industry such as Revit, Rhino, Grasshopper, AutoCAD, Civil 3D, Excel, Unreal Engine, Unity, QGIS, Blender, ArchiCAD and more!

# Components

### Principles & SDKs 

Speckle is not a file based system - it's a versioned object graph storage for large 3D models, with multiple persistance layers. Read more about [the core architecture here](https://speckle.guide/dev/architecture.html).
What this means, in short, is that we decompose 3D data into their subconstituent atomic parts, hash them and store them in various places, such as databases, the [Speckle Server](https://github.com/specklesystems/speckle-server), or the file system. We allow you to access this data in a linear fashion, suited for various processing tasks, or in a structured manner, suited for authoring applications and human understanding.


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
- [3D Viewer](https://github.com/specklesystems/speckle-server/blob/main/packages/viewer): a threejs extension that allows you to display 3D data
- and more!

# Community & Contributions

At Speckle, our mission is to make the AEC industry better. This starts by building a tightly connected team that shares thoughts and data openly. This is our approach, and we want you to achieve the same. [Join our Community Forum and be part of the journey!]([url](https://speckle.community/invites/Fbk5j1wbRW ))






